import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { createTestApp } from './setup-app';

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
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ name: '박지훈', reason: '현재 이름과 같은 요청입니다.' }).expect(400);
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ name: '박지훈 변경', email: 'owned@example.test', reason: '이메일까지 바꾸려는 요청입니다.' }).expect(400);
  });

  it('creates one pending request and enforces list/detail ownership', async () => {
    const created = await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ name: '박지훈 변경', phone: '+82-10-9999-0000', countryCode: 'us', timeZone: 'America/New_York', reason: '해외 근무지와 연락처가 변경되었습니다.' })
      .expect(201);
    mainRequestId = created.body.id;
    expect(created.body).toMatchObject({ requesterId: 1, baseProfileVersion: 1, status: 'pending' });
    expect(created.body.requestedChanges).toEqual({
      name: '박지훈 변경', phone: '+82-10-9999-0000', countryCode: 'US', timeZone: 'America/New_York',
    });
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ phone: '+82-10-1111-2222', reason: '추가 변경 요청을 제출합니다.' }).expect(409);

    const mine = await http.get('/api/profile-change-requests/mine').set(bearer(tokens.instructor)).expect(200);
    expect(mine.body.some((row: RequestRow) => row.id === mainRequestId)).toBe(true);
    await http.get('/api/profile-change-requests').set(bearer(tokens.instructor)).expect(403);
    await http.get(`/api/profile-change-requests/${mainRequestId}`).set(bearer(tokens.foreign)).expect(403);
    await http.get(`/api/profile-change-requests/${mainRequestId}`).set(bearer(tokens.manager)).expect(200);
    await http.get('/api/profile-change-requests').set(bearer(tokens.manager)).expect(200);
  });

  it('requires rejection reason and disallows self decision', async () => {
    const own = await http.post('/api/profile-change-requests').set(bearer(tokens.manager))
      .send({ phone: '+82-10-4000-4000', reason: '관리자 본인 연락처 변경 요청입니다.' }).expect(201);
    await http.post(`/api/profile-change-requests/${own.body.id}/approve`).set(bearer(tokens.manager)).expect(403);
    await http.post(`/api/profile-change-requests/${own.body.id}/reject`).set(bearer(tokens.admin))
      .send({ reason: '짧음' }).expect(400);
    const rejected = await http.post(`/api/profile-change-requests/${own.body.id}/reject`).set(bearer(tokens.admin))
      .send({ reason: '연락처 소유 확인 자료가 필요합니다.' }).expect(201);
    expect(rejected.body).toMatchObject({ status: 'rejected', decidedBy: 5, rejectionReason: '연락처 소유 확인 자료가 필요합니다.' });
  });

  it('returns 409 for a stale base profile version', async () => {
    const stale = await http.post('/api/profile-change-requests').set(bearer(tokens.foreign))
      .send({ phone: '+44-20-0000-0000', reason: '영국 현지 연락처 변경 요청입니다.' }).expect(201);
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
      name: '박지훈 변경', phone: '+82-10-9999-0000', profileVersion: 2,
    });
    expect([left.body, right.body].find((body) => body.status === 'approved')).toMatchObject({ appliedProfileVersion: 2 });
    const audits = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'profile_change_requests' && row.entityId === mainRequestId && row.action === 'approve');
    expect(audits).toHaveLength(1);
    expect(db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'users' && row.entityId === 1 && row.action === 'update')).toHaveLength(1);
  });

  it('rolls back request and user when audit persistence fails', async () => {
    const created = await http.post('/api/profile-change-requests').set(bearer(tokens.admin))
      .send({ phone: '+82-10-5555-5555', reason: '관리자 연락처 변경을 요청합니다.' }).expect(201);
    const before = { ...db.findById<UserRow>('users', 5)! };
    const audit = app.get(AuditService);
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected audit failure'));
    await http.post(`/api/profile-change-requests/${created.body.id}/approve`).set(bearer(tokens.manager)).expect(500);
    spy.mockRestore();
    const after = db.findById<UserRow>('users', 5)!;
    expect(after.phone ?? null).toBe(before.phone ?? null);
    expect(after.profileVersion).toBe(before.profileVersion);
    expect(db.findById<RequestRow>('profile_change_requests', created.body.id)?.status).toBe('pending');
  });
});
