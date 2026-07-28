// [TBO-53 C1 2026-07-23] 2-instance 머니 경쟁 실증(PG 전용) — TBO-50 §8 C1 완료 조건 그대로.
//  두 createTestApp 인스턴스(A/B)는 메모리(read-model)가 분리되고 PostgreSQL만 공유한다 = Vercel
//  다중 인스턴스 등가. 판정: 수납/환불/approve 경쟁에서 **단 하나의 상태·원장·audit**.
//  실행: RUN_MONEY_RACE_E2E=1 DATABASE_URL=postgres://... (로컬 fresh DB 권장 — 빈 DB면 QA 계정 bootstrap)
//  규약(CLAUDE §25 승계): TEST_BUSINESS_FIXTURES=0 · 고정 demo 자격증명 금지 · stamp aggregate ·
//  기존 활성 계정 있는 DB에서는 bootstrap 금지(기존 super_admin 재사용) · 종료 시 QA 행 soft-delete.
import { INestApplication } from '@nestjs/common';
import { config } from 'dotenv';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { USERS_SPEC } from '../src/database/calendar-asset-specs';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersService } from '../src/modules/users/users.service';
import { studentAggregateBody } from './fixtures/student-profile';

const enabled = process.env.RUN_MONEY_RACE_E2E === '1';
const describeDb = enabled ? describe : describe.skip;

type UserRow = { id: number; role: string; status: string; deletedAt?: string | null };

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const openApps = new Set<INestApplication>();

function tokenFor(app: INestApplication, actorId: number, role: string, name: string): string {
  return app.get(AuthService).sign({ sub: actorId, name, roles: [role], authVersion: 1, mustChangePassword: false });
}

describeDb('[TBO-53 C1] Money race — 2-instance PG (e2e)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let httpA: ReturnType<typeof request>;
  let httpB: ReturnType<typeof request>;
  let admin = ''; // A에서 발급 — 서명 비밀 동일하므로 B에서도 유효(계정 검증은 DB)
  let adminB = '';
  let ceoId = 0;
  const stamp = `${Date.now()}_${process.pid}`;
  let studentId = 0;
  let instructorId = 0;
  let courseId = 0;
  let sessionId = 0;
  const cleanupIds: Array<{ table: string; id: number }> = [];

  const pgQuery = async (sql: string, params: unknown[] = []) =>
    appA.get(PostgresConnectionService).query(sql, params);

  beforeAll(async () => {
    config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      throw new Error('RUN_MONEY_RACE_E2E=1은 DATABASE_URL이 필요합니다(로컬 fresh DB 권장).');
    }
    process.env.TEST_BUSINESS_FIXTURES = '0'; // 픽스처를 PG 검증에 섞지 않는다(CLAUDE §25)

    appA = await createTestApp();
    openApps.add(appA);
    const users = appA.get(UsersService).findAll() as unknown as UserRow[];
    const activeUsers = users.filter((row) => row.status === 'active' && row.deletedAt == null);
    const ceo = activeUsers.find((row) => row.role === 'super_admin');
    if (ceo) {
      ceoId = ceo.id;
    } else if (activeUsers.length > 0) {
      throw new Error('활성 계정이 있는 DB에는 QA super_admin을 bootstrap하지 않습니다 — 기존 대표 계정으로 실행하세요.');
    } else {
      // 완전 빈 DB(로컬 fresh) 한정 bootstrap — 고유 stamp 자격증명, 종료 시 soft-delete.
      const passwordHash = await bcrypt.hash(`Race!${stamp}`, 12);
      const row = await appA.get(PostgresCollectionStore).insert(USERS_SPEC, {
        webId: `race_ceo_${stamp}`, name: `RACE 대표 ${stamp}`, email: `race_${stamp}@qa.local`,
        role: 'super_admin', status: 'active', passwordHash, emailVerified: true,
      } as never);
      ceoId = (row as { id: number }).id;
      cleanupIds.push({ table: 'users', id: ceoId });
    }

    appB = await createTestApp();
    openApps.add(appB);
    httpA = request(appA.getHttpServer());
    httpB = request(appB.getHttpServer());
    admin = tokenFor(appA, ceoId, 'super_admin', 'RACE 대표');
    adminB = tokenFor(appB, ceoId, 'super_admin', 'RACE 대표');

    // QA aggregate 준비(전부 A 인스턴스 API 경유 — B 메모리에는 없음 = stale 재현 장치)
    // [74D-1] 강사 직접 등록은 SudoGuard — Bearer 단독은 403 SUDO_REQUIRED.
    instructorId = Number((await httpA.post('/api/users/instructors').set(sudoAuthHeaders(appA, admin)).send({
      webId: `race_inst_${stamp}`, name: `RACE 강사 ${stamp}`, password: `Race!${stamp}x`,
      defaultHourlyRate: 40000, canTeachKinder: false, countryCode: 'KR', timeZone: 'Asia/Seoul',
    }).expect(201)).body.id);
    cleanupIds.push({ table: 'users', id: instructorId });
    const subjectId = Number((await httpA.post('/api/subjects').set(auth(admin))
      .send({ code: `race_${stamp}`, name: `RACE 과목 ${stamp}` }).expect(201)).body.id);
    cleanupIds.push({ table: 'subjects', id: subjectId });
    courseId = Number((await httpA.post('/api/courses').set(auth(admin)).send({
      name: `RACE 코스 ${stamp}`, subjectId, instructorId, price: 300000, isKinder: false,
    }).expect(201)).body.id);
    cleanupIds.push({ table: 'courses', id: courseId });
    const studentRes = await httpA.post('/api/students').set(auth(admin))
      .send(studentAggregateBody(`RACE학생${String(Date.now()).slice(-7)}`, {
        interests: [{ customLabel: 'RACE 희망 수업 A', priority: 1 }, { customLabel: 'RACE 희망 수업 B', priority: 2 }], // 픽스처 courseId 기본값 회피(fixture-less PG) — DTO 최소 2건
      }));
    if (studentRes.status !== 201) throw new Error(`student create ${studentRes.status}: ${JSON.stringify(studentRes.body).slice(0, 400)}`);
    studentId = Number(studentRes.body.student.id);
    cleanupIds.push({ table: 'students', id: studentId });
    const enrollmentId = Number((await httpA.post('/api/enrollments').set(auth(admin))
      .send({ studentId, courseId, totalSessions: 4 }).expect(201)).body.id);
    cleanupIds.push({ table: 'enrollments', id: enrollmentId });
    sessionId = Number((await httpA.post('/api/schedule').set(auth(admin)).send({
      courseId, instructorId, sessionDate: '2099-11-01', startTime: '08:00', endTime: '09:00', mode: 'online',
      topic: `RACE 세션 ${stamp}`,
    }).expect(201)).body.row.id);
    cleanupIds.push({ table: 'class_sessions', id: sessionId });
  }, 120_000);

  afterAll(async () => {
    // QA 행 정리 — 정상 API delete 불가 항목은 soft-delete 표식(물리 DELETE 금지, CLAUDE §25).
    try {
      for (const { table, id } of cleanupIds.reverse()) {
        await pgQuery(`UPDATE ${table} SET deleted_at = now(), deleted_by = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL`, [ceoId, id]);
      }
    } catch { /* 로컬 fresh DB 정리는 best-effort */ }
    for (const app of openApps) await app.close();
  }, 60_000);

  const ledgerRows = async (paymentId: number) =>
    (await pgQuery(`SELECT direction, amount::int AS amount FROM transactions WHERE payment_id = $1 AND deleted_at IS NULL`, [paymentId])) as Array<{ direction: string; amount: number }>;

  it('(a) A·B 동시 수납 — 정확히 1승자, 원장 입금 1행', async () => {
    const paymentId = Number((await httpA.post('/api/payments').set(auth(admin))
      .send({ studentId, amount: 150000 }).expect(201)).body.id);
    cleanupIds.push({ table: 'payments', id: paymentId });
    const [ra, rb] = await Promise.all([
      httpA.post(`/api/payments/${paymentId}/pay`).set(sudoAuthHeaders(appA, admin)),
      httpB.post(`/api/payments/${paymentId}/pay`).set(sudoAuthHeaders(appB, adminB)),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses[0]).toBe(201);
    expect([400, 409]).toContain(statuses[1]); // 패자 = 재조회 후 400(이미 수납) 또는 CAS 409
    const ledger = await ledgerRows(paymentId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'in', amount: 150000 });
  });

  it('(b) B 금액 정정 → A(낡은 메모리) 수납 — paid_amount·원장이 정정 금액을 따른다', async () => {
    const paymentId = Number((await httpA.post('/api/payments').set(auth(admin))
      .send({ studentId, amount: 100000 }).expect(201)).body.id);
    cleanupIds.push({ table: 'payments', id: paymentId });
    // B 인스턴스에서 정정(130,000) — A 메모리는 여전히 100,000을 기억한다.
    await httpB.patch(`/api/payments/${paymentId}`).set(auth(adminB)).send({ amount: 130000 }).expect(200);
    const paid = (await httpA.post(`/api/payments/${paymentId}/pay`).set(sudoAuthHeaders(appA, admin)).expect(201)).body;
    expect(paid).toMatchObject({ amount: 130000, paidAmount: 130000 }); // DB 재조회 증명(종전엔 100,000 수납)
    const ledger = await ledgerRows(paymentId);
    expect(ledger).toEqual([{ direction: 'in', amount: 130000 }]);
  });

  it('(e) A·B 동시 환불 — 원장 환불 1행(실수납 금액)', async () => {
    const paymentId = Number((await httpA.post('/api/payments').set(auth(admin))
      .send({ studentId, amount: 80000 }).expect(201)).body.id);
    cleanupIds.push({ table: 'payments', id: paymentId });
    await httpA.post(`/api/payments/${paymentId}/pay`).set(sudoAuthHeaders(appA, admin)).expect(201);
    const [ra, rb] = await Promise.all([
      httpA.post(`/api/payments/${paymentId}/refund`).set(sudoAuthHeaders(appA, admin)),
      httpB.post(`/api/payments/${paymentId}/refund`).set(sudoAuthHeaders(appB, adminB)),
    ]);
    expect([ra.status, rb.status].filter((s) => s === 201)).toHaveLength(1);
    const ledger = await ledgerRows(paymentId);
    expect(ledger.filter((tx) => tx.direction === 'out')).toEqual([{ direction: 'out', amount: 80000 }]);
  });

  it('(c) A 승인 vs B 승인 동시 — approve 성공 1회·audit 1건(모순 이력 0)', async () => {
    const reportId = Number((await httpA.post('/api/reports').set(auth(admin))
      .send({ sessionId, studentId, content: `RACE 보고서 ${stamp}`, status: 'submitted' }).expect(201)).body.id);
    cleanupIds.push({ table: 'session_reports', id: reportId });
    const [ra, rb] = await Promise.all([
      httpA.post(`/api/reports/${reportId}/approve`).set(auth(admin)),
      httpB.post(`/api/reports/${reportId}/approve`).set(auth(adminB)),
    ]);
    expect([ra.status, rb.status].filter((s) => s === 201)).toHaveLength(1); // 패자 400/409
    const [{ count }] = (await pgQuery(
      `SELECT COUNT(*)::int AS count FROM audit_log WHERE entity='session_reports' AND entity_id=$1 AND action='approve'`,
      [reportId],
    )) as Array<{ count: number }>;
    expect(count).toBe(1);
    const [row] = (await pgQuery(`SELECT approval_status FROM session_reports WHERE id=$1`, [reportId])) as Array<{ approval_status: string }>;
    expect(row.approval_status).toBe('approved');
  });

  it('(d) 타 인스턴스 승인 뒤 A(낡은 메모리) 수정/제출 — 400(승인 본문 무단 변경 차단)', async () => {
    // (c)의 보고서는 이미 approved — A 메모리는 생성 시점(submitted)만 기억한다.
    const reportId = cleanupIds.find((row) => row.table === 'session_reports')!.id;
    await httpA.patch(`/api/reports/${reportId}`).set(auth(admin)).send({ content: '변조 시도' }).expect(400);
    await httpA.post(`/api/reports/${reportId}/submit`).set(auth(admin)).expect(400);
  });

  it('(f) 물리 제약 readback — FK 4종·CHECK 3종이 실제 DB에 존재', async () => {
    const rows = (await pgQuery(`SELECT conname FROM pg_constraint WHERE conname = ANY($1)`, [[
      'fk_payments_student', 'fk_payments_enrollment', 'fk_payments_payer_parent',
      'c_payments_amount_nonneg', 'c_payments_paid_amount_nonneg', 'c_payments_status_enum',
      'fk_transactions_payment',
    ]])) as Array<{ conname: string }>;
    expect(rows.map((row) => row.conname).sort()).toHaveLength(7);
  });
});
