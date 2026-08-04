import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { assertExpectedAfter } from '../src/common/expected-after.util';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AuditService } from '../src/modules/audit/audit.service';
import { SESSIONS, type ClassSession } from '../src/modules/schedule/schedule.entity';
import {
  clearInstructorAttendanceAckingImpact,
  completeSessionByAttendance,
  createTestApp,
  setInstructorAttendanceAckingImpact,
} from './setup-app';

const FROM = '2026-06-01';
const TO = '2026-06-30';

describe('session joined-table expected/after integrity (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let token = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => app.close());

  const preview = async (instructorId = 1) =>
    (await http.get(`/api/payouts/preview?instructorId=${instructorId}&from=${FROM}&to=${TO}`).set(auth()).expect(200)).body;
  const summary = async (instructorId = 1) =>
    (await http.get(`/api/schedule/instructor-attendance-summary?instructorId=${instructorId}&from=${FROM}&to=${TO}`).set(auth()).expect(200)).body.rows[0];
  const relations = async (sessionId: number) => ({
    attendance: (await http.get(`/api/attendance?sessionId=${sessionId}`).set(auth()).expect(200)).body
      .map((row: { id: number; studentId: number; status: string }) => ({ id: row.id, studentId: row.studentId, status: row.status })),
    reports: (await http.get(`/api/reports?sessionId=${sessionId}`).set(auth()).expect(200)).body
      .map((row: { id: number; studentId: number; approvalStatus: string }) => ({ id: row.id, studentId: row.studentId, approvalStatus: row.approvalStatus })),
  });

  it('강사 출결 변경은 확인 전 차단하고, 확인 후 시수·정산액만 expected만큼 변경한다', async () => {
    const beforePreview = await preview();
    const line = beforePreview.lines[0];
    const beforeSummary = await summary();
    const beforeRelations = await relations(line.sessionId);

    const blocked = await http.put(`/api/schedule/${line.sessionId}/instructor-attendance`).set(auth())
      .send({ status: 'absent' }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(blocked.body.impact.delta).toMatchObject({
      teachingMinutes: -line.durationMinutes,
      payoutEligibleMinutes: -line.durationMinutes,
      computedAmount: -line.amount,
    });
    assertExpectedAfter('ack 전 관계 무변경', beforeRelations, await relations(line.sessionId));

    expect((await setInstructorAttendanceAckingImpact(http, auth(), line.sessionId, 'absent')).status).toBe(200);
    const afterPreview = await preview();
    const afterSummary = await summary();
    assertExpectedAfter('강사 결석 후 파생값', {
      preview: {
        sessionCount: beforePreview.sessionCount - 1,
        totalMinutes: beforePreview.totalMinutes - line.durationMinutes,
        computedAmount: beforePreview.computedAmount - line.amount,
      },
      summary: { teachingMinutes: beforeSummary.teachingMinutes - line.durationMinutes, absent: beforeSummary.absent + 1 },
      relations: beforeRelations,
    }, {
      preview: { sessionCount: afterPreview.sessionCount, totalMinutes: afterPreview.totalMinutes, computedAmount: afterPreview.computedAmount },
      summary: { teachingMinutes: afterSummary.teachingMinutes, absent: afterSummary.absent },
      relations: await relations(line.sessionId),
    });

    expect((await clearInstructorAttendanceAckingImpact(http, auth(), line.sessionId)).status).toBe(200);
    const cleared = await preview();
    assertExpectedAfter('강사 출결 clear는 held를 scheduled로 되돌려 시수 제외', {
      sessionCount: beforePreview.sessionCount - 1,
      totalMinutes: beforePreview.totalMinutes - line.durationMinutes,
      computedAmount: beforePreview.computedAmount - line.amount,
    }, { sessionCount: cleared.sessionCount, totalMinutes: cleared.totalMinutes, computedAmount: cleared.computedAmount });
  });

  it('학생 출결 변경은 강사 시수·정산액을 바꾸지 않는다', async () => {
    const line = (await preview()).lines[0];
    await http.put('/api/attendance').set(auth()).send({ sessionId: line.sessionId, studentId: 1, status: 'present' }).expect(200);
    const before = { preview: await preview(), summary: await summary() };
    const updated = (await http.put('/api/attendance').set(auth())
      .send({ sessionId: line.sessionId, studentId: 1, status: 'absent' }).expect(200)).body;
    const after = { preview: await preview(), summary: await summary() };
    assertExpectedAfter('학생 출결은 강사 회계 파생값 불변', {
      preview: { totalMinutes: before.preview.totalMinutes, computedAmount: before.preview.computedAmount },
      summary: { teachingMinutes: before.summary.teachingMinutes },
      attendance: { id: updated.id, status: 'absent' },
    }, {
      preview: { totalMinutes: after.preview.totalMinutes, computedAmount: after.preview.computedAmount },
      summary: { teachingMinutes: after.summary.teachingMinutes },
      attendance: { id: updated.id, status: updated.status },
    });
  });

  it('미정산 held 회차 삭제는 영향 확인을 요구하고, 확인 후 종속행을 원자 삭제하며 audit 실패는 전부 롤백한다', async () => {
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: '2026-06-04',
      startTime: '06:00',
      durationMinutes: 60,
      force: true,
    }).expect(201)).body.row as { id: number };
    await completeSessionByAttendance(http, auth(), session.id, [1]);
    const report = (await http.post('/api/reports').set(auth())
      .send({ sessionId: session.id, studentId: 1, content: '삭제 원자성 검증 보고서' }).expect(201)).body as { id: number };
    await http.post(`/api/reports/${report.id}/approve`).set(auth()).expect(201);

    const beforeRelations = await relations(session.id);
    const blocked = await http.delete(`/api/schedule/${session.id}`).set(auth()).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(blocked.body.impact).toMatchObject({
      changed: true,
      before: { teachingMinutes: 60 },
      after: { teachingMinutes: 0, payoutEligibleMinutes: 0, computedAmount: 0 },
      delta: { teachingMinutes: -60 },
    });
    expect(blocked.body.impactHash).toMatch(/^[a-f0-9]{64}$/);
    await http.delete(`/api/schedule/${session.id}?acknowledgeAccountingImpact=yes`).set(auth()).expect(400);
    await http.delete(`/api/schedule/${session.id}`).set(auth()).query({
      acknowledgeAccountingImpact: 'true',
      expectedAccountingImpactHash: '0'.repeat(64),
    }).expect(409);
    assertExpectedAfter('삭제 확인 전 관계 무변경', beforeRelations, await relations(session.id));
    await http.get(`/api/schedule/${session.id}`).set(auth()).expect(200);

    const beforeRollbackPreview = await preview();
    const audit = app.get(AuditService);
    const auditSpy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected session delete audit failure'));
    await http.delete(`/api/schedule/${session.id}`).set(auth()).query({
      acknowledgeAccountingImpact: 'true',
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(500);
    auditSpy.mockRestore();
    assertExpectedAfter('삭제 audit 실패 전체 롤백', beforeRelations, await relations(session.id));
    await http.get(`/api/schedule/${session.id}`).set(auth()).expect(200);
    const afterRollbackPreview = await preview();
    assertExpectedAfter('삭제 audit 실패 정산 미리보기 롤백', {
      sessionCount: beforeRollbackPreview.sessionCount,
      totalMinutes: beforeRollbackPreview.totalMinutes,
      computedAmount: beforeRollbackPreview.computedAmount,
    }, {
      sessionCount: afterRollbackPreview.sessionCount,
      totalMinutes: afterRollbackPreview.totalMinutes,
      computedAmount: afterRollbackPreview.computedAmount,
    });
    expect(db.findAll<{ entity: string; entityId: number; action: string }>('audit_log')
      .filter((row) => row.entity === SESSIONS && row.entityId === session.id && row.action === 'delete')).toHaveLength(0);

    await http.delete(`/api/schedule/${session.id}`).set(auth()).query({
      acknowledgeAccountingImpact: 'true',
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(200);
    await http.get(`/api/schedule/${session.id}`).set(auth()).expect(404);
    assertExpectedAfter('삭제 확인 후 종속행 soft delete', { attendance: [], reports: [] }, await relations(session.id));
    expect(db.findAll<{ entity: string; entityId: number; action: string }>('audit_log')
      .filter((row) => row.entity === SESSIONS && row.entityId === session.id && row.action === 'delete')).toHaveLength(1);
  });

  it('정산 연결 세션은 확인값이 있어도 원장 회수 전 변경·삭제되지 않는다', async () => {
    const payouts = (await http.get('/api/payouts').set(auth()).expect(200)).body;
    const paid = payouts.find((row: { instructorId: number; status: string }) => row.instructorId === 2 && row.status === 'paid');
    const sessionId = paid.lines[0].sessionId;
    const before = (await http.get(`/api/schedule?from=${FROM}&to=${TO}&instructorId=2`).set(auth()).expect(200)).body
      .find((row: { id: number }) => row.id === sessionId);
    const blocked = await http.patch(`/api/schedule/${sessionId}`).set(auth())
      .send({ durationMinutes: before.durationMinutes + 30, acknowledgeAccountingImpact: true }).expect(409);
    expect(blocked.body.code).toBe('PAYOUT_REVERSAL_REQUIRED');
    const deleteBlocked = await http.delete(`/api/schedule/${sessionId}?acknowledgeAccountingImpact=true`).set(auth()).expect(409);
    expect(deleteBlocked.body).toMatchObject({
      code: 'PAYOUT_REVERSAL_REQUIRED',
      impact: { payoutId: paid.id },
    });
    const after = (await http.get(`/api/schedule?from=${FROM}&to=${TO}&instructorId=2`).set(auth()).expect(200)).body
      .find((row: { id: number }) => row.id === sessionId);
    assertExpectedAfter('정산 연결 세션 불변', before, after);
  });

  it('반복 범위 변경은 동반 회차 하나라도 정산 연결이면 시리즈 전체를 불변으로 둔다', async () => {
    // [TBO-29C C2] 시리즈는 서버 발급 bulk command로 생성(클라이언트 seriesId 폐기). 2099-12-01=화.
    const madeSeries = (await http.post('/api/schedule/series').set(auth()).send({
      courseId: 10, instructorId: 1,
      repeat: { kind: 'weekly', weekdays: [2], startsOn: '2099-12-01', endsOn: '2099-12-08' },
      startTime: '08:00', durationMinutes: 60, topic: '정산 잠금 반복', force: true,
    }).expect(201)).body as { series: { id: number }; rows: Array<{ id: number }> };
    const seriesId = madeSeries.series.id;
    const [first, second] = madeSeries.rows;

    // [TBO-29C C4] fixture도 write-through — InMemoryDatabase 직접 주입은 PG 권위 경로에 비가시(C0 발견 ③).
    const { ClassSessionsStore } = await import('../src/modules/schedule/class-sessions.store');
    const sessionsStore = app.get(ClassSessionsStore);
    await sessionsStore.update(second.id, { payoutId: 999 } as never);
    const db = app.get(InMemoryDatabase);
    const before = db.findBy<ClassSession>(SESSIONS, (row) => row.seriesId === seriesId)
      .map(({ id, sessionDate, durationMinutes, topic, payoutId }) => ({ id, sessionDate, durationMinutes, topic, payoutId }));

    const blocked = await http.patch(`/api/schedule/${first.id}`).set(auth()).send({
      durationMinutes: 90,
      topic: '변경되면 안 됨',
      scope: 'this_and_following',
      acknowledgeAccountingImpact: true,
      force: true,
    }).expect(409);
    expect(blocked.body.code).toBe('PAYOUT_REVERSAL_REQUIRED');
    expect(blocked.body.impact.payoutId).toBe(999);

    const after = db.findBy<ClassSession>(SESSIONS, (row) => row.seriesId === seriesId)
      .map(({ id, sessionDate, durationMinutes, topic, payoutId }) => ({ id, sessionDate, durationMinutes, topic, payoutId }));
    assertExpectedAfter('반복 시리즈 정산 잠금 불변', before, after);
  });

  // [대표 지시 ⑭ 2026-07-16] 보강 세션 → 원본(결강) 링크 — 참조 무결성 + FE 해소 판정 근거.
  it('보강 링크: 원본 실존 검증(없으면 400)·보강 체이닝 금지·정상 링크는 저장된다', async () => {
    // 원본(결강) 세션 — 과거 날짜 + canceled 로 생성(과거 생성 허용은 대표 요구 ⑪).
    //  ⚠ POST /schedule 응답은 { row, conflicts } 래핑 — row를 꺼내 쓴다(id undefined 함정).
    const original = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-02', startTime: '07:00', durationMinutes: 60,
      status: 'canceled', topic: '결강 원본', force: true,
    }).expect(201)).body.row;
    expect(original.id).toBeGreaterThan(0);

    // 존재하지 않는 원본 → 400
    await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-09', startTime: '07:00', durationMinutes: 60,
      status: 'makeup', makeupForSessionId: 999999, force: true,
    }).expect(400);

    // 정상 보강 링크 → 저장 + 응답/DB에 반영
    const makeup = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-09', startTime: '07:00', durationMinutes: 60,
      status: 'makeup', makeupForSessionId: original.id, topic: '보강', force: true,
    }).expect(201)).body.row;
    expect(makeup.id).toBeGreaterThan(0);
    const db = app.get(InMemoryDatabase);
    expect(db.findById<ClassSession>(SESSIONS, makeup.id)!.makeupForSessionId).toBe(original.id);

    // 보강 세션을 다시 원본으로 지정(체이닝) → 400 (원본↔보강 1단 링크만)
    await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-16', startTime: '07:00', durationMinutes: 60,
      status: 'makeup', makeupForSessionId: makeup.id, force: true,
    }).expect(400);
  });
});
