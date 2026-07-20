import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { createTestApp } from './setup-app';
// [TBO-31 C1 D4] 프로필 변경 = 비밀번호 + 본인 이메일 OTP 상시 — 각 생성 전에 verified challenge 위조.
import { forgeVerifiedEmailChallenge } from './profile-challenge-helper';

type UserRow = { id: number; name: string; phone?: string | null; profileVersion: number };
type RequestRow = { id: number; requesterId: number; status: string; rejectionReason?: string | null };

describe('Profile change requests (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const tokens: Record<string, string> = {};
  let mainRequestId = 0;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken as string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    tokens.super = await login('admin');
    tokens.manager = await login('manager');
    tokens.admin = await login('prof_admin');
    tokens.instructor = await login('park_inst');
    tokens.foreign = await login('jung_inst');
  });

  afterAll(async () => { await app.close(); });

  it('keeps only auth entry points and health public', async () => {
    await http.get('/api/health').expect(200);
    const dbHealth = await http.get('/api/health/db').expect(200);
    expect(dbHealth.body.db).toEqual(expect.objectContaining({ configured: expect.any(Boolean), ready: expect.any(Boolean) }));
    expect(dbHealth.body.db).not.toHaveProperty('host');
    expect(dbHealth.body.db).not.toHaveProperty('error');
    await http.post('/api/auth/signup').send({}).expect(400);
    await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'wrong' }).expect(401);
    await http.get('/api/users/me/profile').expect(401);
    await http.get('/api/profile-change-requests/mine').expect(401);
    await http.get('/api/users').set(bearer(tokens.instructor)).expect(403);
    await http.get('/api/users').set(bearer(tokens.manager)).expect(200);
  });

  it('returns the staff profile and blocks no-op and mass assignment', async () => {
    const profile = await http.get('/api/users/me/profile').set(bearer(tokens.instructor)).expect(200);
    expect(profile.body).toMatchObject({ id: 1, webId: 'park_inst', name: '박지훈', profileVersion: 1 });
    // [TBO-29B-4] 모든 변경은 현재 비밀번호 재확인 — 누락 400, 오입력 403
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ name: '박지훈 변경', reason: '비밀번호 재확인 누락 요청입니다.' }).expect(400);
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'wrong-password', name: '박지훈 변경', reason: '잘못된 비밀번호로 요청합니다.' }).expect(403);
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', name: '박지훈', reason: '현재 이름과 같은 요청입니다.' }).expect(400);
    // 연락처(email/phone) 변경은 인증 challenge 없이는 400 — 상세 흐름은 profile-verification.e2e-spec
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', email: 'owned@example.test', reason: '이메일까지 바꾸려는 요청입니다.' }).expect(400);
    // [TBO-31 C1 D4] 비연락처 변경도 본인 이메일 OTP 상시 필수 — challenge 없이 400(전 역할)
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', name: '박지훈 변경', reason: '본인 인증 없이 이름 변경 시도.' }).expect(400);
    // role 등 비허용 key는 whitelist가 차단(mass assignment)
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', name: '박지훈 변경', role: 'super_admin', reason: '권한 상승을 시도합니다.' }).expect(400);
  });

  it('creates one pending request and enforces list/detail ownership', async () => {
    // [TBO-31 C1 D4] 본인(현재) 이메일로 verified된 challenge 소비 — 같은 tx 일회 소비.
    const challengeId = await forgeVerifiedEmailChallenge(app, 1, 'park@tnacademy.test');
    const created = await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', name: '박지훈 변경', countryCode: 'us', timeZone: 'America/New_York', verificationChallengeId: challengeId, reason: '해외 근무지 정보가 변경되었습니다.' })
      .expect(201);
    mainRequestId = created.body.id;
    expect(created.body).toMatchObject({ requesterId: 1, baseProfileVersion: 1, status: 'pending' });
    expect(created.body.requestedChanges).toEqual({
      name: '박지훈 변경', countryCode: 'US', timeZone: 'America/New_York',
    });
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', name: '박지훈 3차', reason: '추가 변경 요청을 제출합니다.' }).expect(409);

    const mine = await http.get('/api/profile-change-requests/mine').set(bearer(tokens.instructor)).expect(200);
    expect(mine.body.some((row: RequestRow) => row.id === mainRequestId)).toBe(true);
    await http.get('/api/profile-change-requests').set(bearer(tokens.instructor)).expect(403);
    await http.get(`/api/profile-change-requests/${mainRequestId}`).set(bearer(tokens.foreign)).expect(403);
    await http.get(`/api/profile-change-requests/${mainRequestId}`).set(bearer(tokens.manager)).expect(200);
    await http.get('/api/profile-change-requests').set(bearer(tokens.manager)).expect(200);
  });

  it('requires rejection reason and disallows self decision', async () => {
    const challengeId = await forgeVerifiedEmailChallenge(app, 4, 'manager@tnacademy.test');
    const own = await http.post('/api/profile-change-requests').set(bearer(tokens.manager))
      .send({ currentPassword: 'demo1234', countryCode: 'JP', verificationChallengeId: challengeId, reason: '관리자 본인 근무지 변경 요청입니다.' }).expect(201);
    await http.post(`/api/profile-change-requests/${own.body.id}/approve`).set(bearer(tokens.manager)).expect(403);
    await http.post(`/api/profile-change-requests/${own.body.id}/reject`).set(bearer(tokens.admin))
      .send({ reason: '짧음' }).expect(400);
    const rejected = await http.post(`/api/profile-change-requests/${own.body.id}/reject`).set(bearer(tokens.admin))
      .send({ reason: '연락처 소유 확인 자료가 필요합니다.' }).expect(201);
    expect(rejected.body).toMatchObject({ status: 'rejected', decidedBy: 5, rejectionReason: '연락처 소유 확인 자료가 필요합니다.' });
  });

  it('returns 409 for a stale base profile version', async () => {
    const challengeId = await forgeVerifiedEmailChallenge(app, 2, 'jung@tnacademy.test');
    const stale = await http.post('/api/profile-change-requests').set(bearer(tokens.foreign))
      .send({ currentPassword: 'demo1234', timeZone: 'Europe/Paris', verificationChallengeId: challengeId, reason: '현지 시간대 변경 요청입니다.' }).expect(201);
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) await pg.query('UPDATE users SET profile_version = 2 WHERE id = 2');
    db.update<UserRow>('users', 2, { profileVersion: 2 });
    await http.post(`/api/profile-change-requests/${stale.body.id}/approve`).set(bearer(tokens.manager)).expect(409);
    expect(db.findById<RequestRow>('profile_change_requests', stale.body.id)?.status).toBe('pending');
  });

  it('commits one concurrent approval with user CAS, version increment, and one audit', async () => {
    const [left, right] = await Promise.all([
      http.post(`/api/profile-change-requests/${mainRequestId}/approve`).set(bearer(tokens.manager)),
      http.post(`/api/profile-change-requests/${mainRequestId}/approve`).set(bearer(tokens.admin)),
    ]);
    expect([left.status, right.status].sort()).toEqual([201, 409]);
    expect(db.findById<UserRow>('users', 1)).toMatchObject({
      name: '박지훈 변경', profileVersion: 2,
    });
    expect([left.body, right.body].find((body) => body.status === 'approved')).toMatchObject({ appliedProfileVersion: 2 });
    const audits = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'profile_change_requests' && row.entityId === mainRequestId && row.action === 'approve');
    expect(audits).toHaveLength(1);
    expect(db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'users' && row.entityId === 1 && row.action === 'update')).toHaveLength(1);
  });

  it('rolls back request and user when audit persistence fails', async () => {
    const challengeId = await forgeVerifiedEmailChallenge(app, 5, 'prof.admin@tnacademy.test');
    const created = await http.post('/api/profile-change-requests').set(bearer(tokens.admin))
      .send({ currentPassword: 'demo1234', name: '한서윤 변경', verificationChallengeId: challengeId, reason: '관리자 표시명 변경을 요청합니다.' }).expect(201);
    const before = { ...db.findById<UserRow>('users', 5)! };
    const audit = app.get(AuditService);
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected audit failure'));
    await http.post(`/api/profile-change-requests/${created.body.id}/approve`).set(bearer(tokens.manager)).expect(500);
    spy.mockRestore();
    const after = db.findById<UserRow>('users', 5)!;
    expect(after.name).toBe(before.name);
    expect(after.profileVersion).toBe(before.profileVersion);
    expect(db.findById<RequestRow>('profile_change_requests', created.body.id)?.status).toBe('pending');
  });

  // [E0.5 ①] 대표(super_admin)는 자기 결정 금지 규칙의 명시 예외 — 같은 tx에서 즉시 적용.
  //  요청 행·audit(create+users update+approve)는 일반 경로와 동일하게 남는다(추적성).
  it('applies super_admin changes instantly in the same tx with full audit', async () => {
    const me = await http.get('/api/users/me/profile').set(bearer(tokens.super)).expect(200);
    const version = me.body.profileVersion as number;
    // [TBO-31 C1 D4] super_admin 즉시 적용도 본인 이메일 OTP 동일 적용(대표도 예외 없음 — 지시 6)
    await http.post('/api/profile-change-requests').set(bearer(tokens.super))
      .send({ currentPassword: 'demo1234', name: '김민선', reason: '본인 인증 없는 대표 즉시 적용 시도.' }).expect(400);
    const challengeId = await forgeVerifiedEmailChallenge(app, 3, 'admin@tnacademy.test');
    const created = await http.post('/api/profile-change-requests').set(bearer(tokens.super))
      .send({ currentPassword: 'demo1234', name: '김민선', verificationChallengeId: challengeId, reason: '대표 표시 이름을 실명으로 변경합니다.' })
      .expect(201);
    expect(created.body).toMatchObject({
      requesterId: me.body.id,
      status: 'approved',
      decidedBy: me.body.id,
      appliedProfileVersion: version + 1,
    });
    expect(created.body.decidedAt).toBeTruthy();

    const after = await http.get('/api/users/me/profile').set(bearer(tokens.super)).expect(200);
    expect(after.body).toMatchObject({ name: '김민선', profileVersion: version + 1 });

    // audit 3건: 요청 create + users update + 요청 approve (모두 대표 본인 actor).
    const requestAudits = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'profile_change_requests' && row.entityId === created.body.id);
    expect(requestAudits.map((row) => row.action).sort()).toEqual(['approve', 'create']);
    const userAudits = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'users' && row.entityId === me.body.id && row.action === 'update');
    expect(userAudits.length).toBeGreaterThanOrEqual(1);

    // 즉시 적용이라 pending이 남지 않는다 — 연속 변경이 409 없이 가능(새 challenge로 재인증).
    const secondChallengeId = await forgeVerifiedEmailChallenge(app, 3, 'admin@tnacademy.test');
    const second = await http.post('/api/profile-change-requests').set(bearer(tokens.super))
      .send({ currentPassword: 'demo1234', timeZone: 'Asia/Seoul', countryCode: 'KR', verificationChallengeId: secondChallengeId, reason: '대표 근무지 정보를 정리합니다.' })
      .expect(201);
    expect(second.body.status).toBe('approved');
    // 일반 역할(강사·매니저·admin)은 종전대로 승인제 — 위 테스트들이 pending 경로를 계속 검증한다.
  });
});
