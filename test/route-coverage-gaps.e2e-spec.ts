// [B8 E4 2026-07-16] 커버리지 매트릭스(scripts/e2e-route-coverage.ts)가 검출한 미커버 9연산 보충.
//  전부 "401만 기록"(무토큰 스윕만 통과) — 가드 뒤 본 로직이 한 번도 실행된 적 없던 라우트들.
//  각 연산 최소: 정상 경로 + (역할 게이트가 있으면) 강사 403 + 없는 id 404/400.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('Route coverage gaps (e2e, B8 E4)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let inst = '';
  let inst2 = ''; // [TBO-32 C4] 타인 강사(jung_inst=강사2) — 단건 스코프 403 검증용
  let adminId = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    inst2 = (await http.post('/api/auth/login').send({ webId: 'jung_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    adminId = Number(db.findAll<{ id: number; webId: string }>('users').find((u) => u.webId === 'admin')?.id ?? 0);
    expect(adminId).toBeGreaterThan(0);
  });
  afterAll(async () => { await app.close(); });

  it('카탈로그 단건 GET 4종(courses/subjects/rooms/enrollments) — 200 + 없는 id 404', async () => {
    const course = (await http.get('/api/courses/10').set(auth(admin)).expect(200)).body;
    expect(course.id).toBe(10);
    await http.get('/api/courses/999999').set(auth(admin)).expect(404);

    const subject = (await http.get('/api/subjects/1').set(auth(admin)).expect(200)).body;
    expect(subject.id).toBe(1);
    await http.get('/api/subjects/999999').set(auth(admin)).expect(404);

    const room = (await http.get('/api/rooms/1').set(auth(admin)).expect(200)).body;
    expect(room.id).toBe(1);
    await http.get('/api/rooms/999999').set(auth(admin)).expect(404);

    const anyEnrollment = db.findAll<{ id: number }>('enrollments')[0];
    const enrollment = (await http.get(`/api/enrollments/${anyEnrollment.id}`).set(auth(admin)).expect(200)).body;
    expect(enrollment.id).toBe(anyEnrollment.id);
    expect(typeof enrollment.completedSessions).toBe('number'); // 파생 필드(withDerivedCompletedSessions)
    await http.get('/api/enrollments/999999').set(auth(admin)).expect(404);
  });

  it('재무 단건 GET 2종(payments/expenses) — 대표 200 · 강사 403(역할 게이트) · 없는 id 404', async () => {
    const anyPayment = db.findAll<{ id: number }>('payments')[0];
    expect((await http.get(`/api/payments/${anyPayment.id}`).set(auth(admin)).expect(200)).body.id).toBe(anyPayment.id);
    await http.get(`/api/payments/${anyPayment.id}`).set(auth(inst)).expect(403);
    await http.get('/api/payments/999999').set(auth(admin)).expect(404);

    const expense = (await http.post('/api/expenses').set(auth(admin))
      .send({ category: 'meal', title: 'B8 커버리지 검증', amount: 5000, spentAt: '2026-07-16' }).expect(201)).body;
    expect((await http.get(`/api/expenses/${expense.id}`).set(auth(admin)).expect(200)).body.title).toBe('B8 커버리지 검증');
    await http.get(`/api/expenses/${expense.id}`).set(auth(inst)).expect(403);
    await http.get('/api/expenses/999999').set(auth(admin)).expect(404);
  });

  it('GET /payouts/:id — 대표 200 · 강사 본인 200 · 타인 강사 403(B7 스코프) · 없는 id 404', async () => {
    // 데모 시드: 강사 1은 6월에 적격 세션(미정산)이 있다(audit-coverage와 동일 전제).
    //  retryTimes(1) 대비 — 재시도에선 세션이 이미 연결돼 generate 400이므로 목록에서 재사용(멱등).
    const gen = await http.post('/api/payouts/generate').set(auth(admin))
      .send({ instructorId: 1, from: '2026-06-01', to: '2026-06-30' });
    const payout = gen.status === 201
      ? gen.body
      : (await http.get('/api/payouts').set(auth(admin)).expect(200)).body
          .find((p: { instructorId: number; periodStart: string }) => p.instructorId === 1 && p.periodStart === '2026-06-01');
    expect(payout).toBeDefined();
    const got = (await http.get(`/api/payouts/${payout.id}`).set(auth(admin)).expect(200)).body;
    expect(got.id).toBe(payout.id);
    expect(got.instructorId).toBe(1);
    // [TBO-62 ⑥ 2026-07-24] 강사는 지급 완료(paid)만 — 본인 것이라도 지급 전(pending)은 403,
    //  확정→지급 후에는 200(타인은 여전히 403). 종전 '본인 pending 200'은 신정책으로 대체.
    await http.get(`/api/payouts/${payout.id}`).set(auth(inst)).expect(403);
    if (payout.status === 'pending') await http.post(`/api/payouts/${payout.id}/confirm`).set(auth(admin)).expect(201);
    const st = (await http.get(`/api/payouts/${payout.id}`).set(auth(admin)).expect(200)).body.status;
    if (st === 'confirmed') await http.post(`/api/payouts/${payout.id}/pay`).set(auth(admin)).expect(201);
    expect((await http.get(`/api/payouts/${payout.id}`).set(auth(inst)).expect(200)).body.id).toBe(payout.id);
    await http.get(`/api/payouts/${payout.id}`).set(auth(inst2)).expect(403);
    await http.get('/api/payouts/999999').set(auth(admin)).expect(404);
  });

  it('POST /profile-verifications/:id/resend — cooldown 400(결정론) · 남의/없는 챌린지 400(존재 은닉)', async () => {
    // 재전송 대기 중인 본인 챌린지 위조(credential-change 패턴) — provider 발송 없이 cooldown 분기 실행.
    const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
    const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
    const store = app.get(PostgresCollectionStore);
    const now = Date.now();
    const challenge = await store.insert<Record<string, unknown> & { id: number }>(PROFILE_VERIFICATION_CHALLENGES_SPEC, {
      requesterId: adminId, channel: 'email', targetNormalized: 'b8-coverage@test.local',
      targetHash: 'test-forged', provider: 'fake_test', providerReference: null,
      codeHash: 'test-forged', status: 'pending', attemptCount: 0, resendCount: 0,
      resendAvailableAt: new Date(now + 60_000).toISOString(), // 미래 → cooldown 분기
      expiresAt: new Date(now + 600_000).toISOString(),
      verifiedAt: null, consumedAt: null, consumedByRequestId: null,
    });
    const cooldown = await http.post(`/api/profile-verifications/${challenge.id}/resend`).set(auth(admin)).expect(400);
    expect(String(cooldown.body.message)).toContain('재전송은');
    // 남의 챌린지(강사가 admin 것 재전송)·없는 id — 존재를 드러내지 않는 일반 400(GENERIC_INVALID 규약)
    await http.post(`/api/profile-verifications/${challenge.id}/resend`).set(auth(inst)).expect(400);
    await http.post('/api/profile-verifications/999999/resend').set(auth(admin)).expect(400);
  });

  it('POST /reports/:id/reject — 관리자 반려(사유 보존) · 강사 403(관리자 전용)', async () => {
    const submitted = db.findAll<{ id: number; approvalStatus: string }>('session_reports')
      .find((r) => r.approvalStatus === 'submitted');
    expect(submitted).toBeTruthy();
    await http.post(`/api/reports/${submitted!.id}/reject`).set(auth(inst)).send({ reason: 'x' }).expect(403);
    const rejected = (await http.post(`/api/reports/${submitted!.id}/reject`).set(auth(admin))
      .send({ reason: 'B8 커버리지 — 반려 사유 보존 검증' }).expect(201)).body;
    expect(rejected.approvalStatus).toBe('rejected');
    expect(rejected.rejectedReason).toBe('B8 커버리지 — 반려 사유 보존 검증');
  });
});
