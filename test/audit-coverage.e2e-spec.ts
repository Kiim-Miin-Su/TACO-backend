// [감사 전수 2026-07-16 — 대표 지시] 전 테이블 CRUD 감사 이력 커버리지 e2e.
//  대표 결정: 캘린더 뷰 프리셋·원장(transactions)도 감사 필수. 각 대표 액션이 audit_log에
//  entity/action/actor를 남기는지, PII(연락처)가 마스킹되는지 검증한다.
import { createHash } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { signupWithOtp } from './signup-helper';

type Audit = { id: number; entity: string; entityId: number; action: string; actorId: number; changes?: Record<string, { before?: unknown; after?: unknown }>; reason?: string };

describe('Audit coverage — 전 테이블 CRUD 이력 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let adminId = 0;

  const audits = (entity: string, entityId?: number) =>
    db.findAll<Audit>('audit_log').filter((a) => a.entity === entity && (entityId == null || a.entityId === entityId));
  const auth = () => ({ Authorization: `Bearer ${admin}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    const res = await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    admin = res.body.accessToken;
    adminId = res.body.account.id;
  });
  afterAll(async () => { await app.close(); });

  it('payments: 청구 생성·수납·환불 + 원장(transactions) 각 1건씩 이력', async () => {
    const created = (await http.post('/api/payments').set(auth())
      .send({ studentId: 1, amount: 111000 }).expect(201)).body;
    expect(audits('payments', created.id).map((a) => a.action)).toEqual(['create']);

    await http.post(`/api/payments/${created.id}/pay`).set(auth()).expect(201);
    const afterPay = audits('payments', created.id).map((a) => a.action);
    expect(afterPay).toEqual(['create', 'status_change']);
    // 원장 입금 1건 — 대표 결정: 원장도 감사 대상.
    const inTx = audits('transactions').filter((a) => a.changes?.category?.after === 'enrollment');
    expect(inTx.length).toBeGreaterThan(0);
    expect(inTx[inTx.length - 1].actorId).toBe(adminId);

    await http.post(`/api/payments/${created.id}/refund`).set(auth()).expect(201);
    expect(audits('payments', created.id).map((a) => a.action)).toEqual(['create', 'status_change', 'status_change']);
    expect(audits('transactions').some((a) => a.changes?.category?.after === 'refund')).toBe(true);
  });

  it('expenses: 생성·승인(+원장)·반려(사유) 이력', async () => {
    const e1 = (await http.post('/api/expenses').set(auth())
      .send({ category: 'supplies', title: '감사 테스트 비품', amount: 12000, spentAt: '2026-07-16' }).expect(201)).body;
    await http.post(`/api/expenses/${e1.id}/approve`).set(auth()).expect(201);
    expect(audits('expenses', e1.id).map((a) => a.action)).toEqual(['create', 'approve']);
    expect(audits('transactions').some((a) => a.changes?.category?.after === 'expense')).toBe(true);

    const e2 = (await http.post('/api/expenses').set(auth())
      .send({ category: 'meal', title: '감사 테스트 반려', amount: 9000, spentAt: '2026-07-16' }).expect(201)).body;
    await http.post(`/api/expenses/${e2.id}/reject`).set(auth()).send({ reason: '증빙 누락' }).expect(201);
    const rej = audits('expenses', e2.id).find((a) => a.action === 'reject');
    expect(rej?.reason).toBe('증빙 누락');
  });

  it('instructor_payouts: 생성·수정·확정·지급 + 원장 출금 이력(세션 연결 기록 포함)', async () => {
    // 데모 시드: 강사 1은 6월에 적격 세션 3건(미정산)이 있다(payouts.service onModuleInit).
    const payout = (await http.post('/api/payouts/generate').set(auth())
      .send({ instructorId: 1, from: '2026-06-01', to: '2026-06-30' }).expect(201)).body;
    const createAudit = audits('instructor_payouts', payout.id).find((a) => a.action === 'create');
    expect(createAudit?.actorId).toBe(adminId);
    expect(Array.isArray(createAudit?.changes?.sessionIds?.after)).toBe(true); // ⚠ class_sessions payout 연결 기록

    await http.post(`/api/payouts/${payout.id}/adjust`).set(auth()).send({ amount: payout.amount - 1000, reason: '조정 테스트' }).expect(201);
    await http.post(`/api/payouts/${payout.id}/confirm`).set(auth()).expect(201);
    await http.post(`/api/payouts/${payout.id}/pay`).set(auth()).expect(201);
    expect(audits('instructor_payouts', payout.id).map((a) => a.action)).toEqual(['create', 'update', 'approve', 'status_change']);
    expect(audits('transactions').some((a) => a.changes?.category?.after === 'instructor_payout' && a.actorId === adminId)).toBe(true);
  });

  it('students: 직접 생성·수정(PII 마스킹)·퇴원 이력', async () => {
    const s = (await http.post('/api/students').set(auth())
      .send({ name: '감사학생', phone: '010-1111-2222' }).expect(201)).body;
    await http.patch(`/api/students/${s.id}`).set(auth()).send({ phone: '010-3333-4444', grade: 11 }).expect(200);
    await http.delete(`/api/students/${s.id}`).set(auth()).expect(200);
    const rows = audits('students', s.id);
    expect(rows.map((a) => a.action)).toEqual(['create', 'update', 'status_change']);
    // PII 마스킹 — 연락처 diff 원문이 이력에 남지 않는다.
    const upd = rows.find((a) => a.action === 'update')!;
    const serialized = JSON.stringify(upd);
    expect(serialized).not.toContain('010-3333-4444');
    expect(serialized).not.toContain('010-1111-2222');
    expect(upd.changes?.grade?.after).toBe(11); // 비민감 필드는 diff 보존
  });

  it('카탈로그·수강·프리셋: subjects/courses/rooms/enrollments/calendar_view_presets 이력', async () => {
    const subj = (await http.post('/api/subjects').set(auth()).send({ code: 'audit_subj', name: '감사과목' }).expect(201)).body;
    expect(audits('subjects', subj.id).map((a) => a.action)).toEqual(['create']);

    const course = (await http.post('/api/courses').set(auth())
      .send({ name: '감사코스', subjectId: subj.id, instructorId: 1, price: 10000, hourlyRate: 10000 }).expect(201)).body;
    expect(audits('courses', course.id).map((a) => a.action)).toEqual(['create']);

    const room = (await http.post('/api/rooms').set(auth()).send({ name: '감사강의실' }).expect(201)).body;
    expect(audits('rooms', room.id).map((a) => a.action)).toEqual(['create']);

    const enr = (await http.post('/api/enrollments').set(auth())
      .send({ studentId: 1, courseId: course.id }).expect(201)).body;
    expect(audits('enrollments', enr.id).map((a) => a.action)).toEqual(['create']);

    // 대표 결정: 뷰 프리셋도 감사 필수 — C·U·D 전부.
    //  (이름 unique — retry 재실행에도 안전하게 매 실행 고유 이름, PATCH는 전체 body 계약)
    const presetBody = {
      name: `감사프리셋-${Date.now()}`, view: 'week', instructorIds: [], studentIds: [], roomIds: [],
      subjects: [], statuses: [], groupOnly: false,
    };
    const preset = (await http.post('/api/view-presets').set(auth()).send(presetBody).expect(201)).body;
    await http.patch(`/api/view-presets/${preset.id}`).set(auth()).send({ ...presetBody, view: 'day' }).expect(200);
    await http.delete(`/api/view-presets/${preset.id}`).set(auth()).expect(200);
    expect(audits('calendar_view_presets', preset.id).map((a) => a.action)).toEqual(['create', 'update', 'delete']);
  });

  it('users: 자기 가입(create, actor=본인)·[잔존 호환] 이메일 링크 인증(update) 이력', async () => {
    const stamp = Date.now();
    const rrn = '930715-1234567';
    // [TBO-31 C1] OTP 인증 가입(emailVerified=true 생성) — signup-helper 재사용
    const res = await signupWithOtp(http, {
      webId: `audit_user_${stamp}`, name: '감사가입', email: `audit_${stamp}@t.test`, password: 'AuditPass1!',
      role: 'instructor', rrn,
    });
    const uid = res.account.id;
    const createRow = audits('users', uid).find((a) => a.action === 'create');
    expect(createRow?.actorId).toBe(uid); // 자기 가입 — actor=본인
    expect(JSON.stringify(createRow)).not.toContain('@t.test'); // 이메일 원문 미기록
    // [TBO-31 D2] RRN은 audit에 **일절 미기록**(마스킹조차 없음 — 기록 자체 생략)
    const allUserAudits = JSON.stringify(audits('users', uid));
    expect(allUserAudits).not.toContain('930715');
    expect(allUserAudits).not.toContain('rrn');

    // 잔존(구 링크 흐름) 미인증 계정의 링크 인증 — update 이력이 계속 남는지(호환 경로 회귀)
    const rawToken = `audit-legacy-token-${stamp}`;
    const hash = createHash('sha256').update(rawToken).digest('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) {
      await pg.query(
        'UPDATE users SET email_verified = false, email_verify_token_hash = $1, email_verify_expires_at = $2 WHERE id = $3',
        [hash, expires, uid],
      );
    }
    db.update('users', uid, { emailVerified: false, emailVerifyTokenHash: hash, emailVerifyExpiresAt: expires } as never);
    await http.get(`/api/auth/verify-email?token=${rawToken}`).expect(200);
    expect(audits('users', uid).some((a) => a.action === 'update' && a.changes?.emailVerified?.after === true)).toBe(true);
  });

  it('session_reports: 생성·승인·반려 이력(본문 원문 미기록)', async () => {
    // 과거 세션 생성(⑪ 허용) → 보고서 생성(제출) → 승인. course 10의 활성 수강생 student 1.
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-03', startTime: '06:00', durationMinutes: 60,
      status: 'held', force: true,
    }).expect(201)).body.row;
    const report = (await http.post('/api/reports').set(auth())
      .send({ sessionId: session.id, studentId: 1, content: '감사 테스트 본문 원문' }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/approve`).set(auth()).expect(201);
    const rows = audits('session_reports', report.id);
    expect(rows.map((a) => a.action)).toEqual(['create', 'approve']);
    expect(JSON.stringify(rows)).not.toContain('감사 테스트 본문 원문'); // 본문 프라이버시
  });
});
