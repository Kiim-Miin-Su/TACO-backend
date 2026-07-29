import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Auth events admin read surface (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminAgent: ReturnType<typeof request.agent>;
  let adminToken = '';
  let managerToken = '';
  let parkId = 0;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    adminAgent = request.agent(app.getHttpServer());
    const adminLogin = await adminAgent.post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' }).expect(201);
    adminToken = adminLogin.body.accessToken;
    const managerLogin = await http.post('/api/auth/login')
      .send({ webId: 'manager', password: 'demo1234' }).expect(201);
    managerToken = managerLogin.body.accessToken;
    const parkLogin = await http.post('/api/auth/login')
      .send({ webId: 'park_inst', password: 'demo1234' }).expect(201);
    parkId = (await http.get('/api/auth/me')
      .set({ Authorization: `Bearer ${parkLogin.body.accessToken}` }).expect(200)).body.sub;
    await http.post('/api/auth/login').send({ webId: 'not-a-user', password: 'wrong' }).expect(401);
  });

  afterAll(async () => { await app.close(); });

  it('requires admin role and sudo reauthentication', async () => {
    await http.get('/api/auth/events').expect(401);
    await http.get('/api/auth/events')
      .set({ Authorization: `Bearer ${managerToken}` }).expect(403);
    await adminAgent.get('/api/auth/events')
      .set({ Authorization: `Bearer ${adminToken}` }).expect(403);
    await adminAgent.post('/api/auth/reauth')
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ currentPassword: 'demo1234' }).expect(201);
  });

  it('returns a bounded PII-minimal projection and supports filters', async () => {
    const rows = (await adminAgent.get('/api/auth/events')
      .set({ Authorization: `Bearer ${adminToken}` })
      .query({ userId: parkId, eventType: 'login_success', success: true, limit: 20 })
      .expect(200)).body;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row: { userId: number; eventType: string; success: boolean }) =>
      row.userId === parkId && row.eventType === 'login_success' && row.success)).toBe(true);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['at', 'eventType', 'failureCode', 'id', 'success', 'userId'].sort(),
    );
    expect(JSON.stringify(rows)).not.toMatch(/ipHash|attemptedWebIdHash|userAgent|requestId/);
  });

  it('rejects invalid event types, timestamps, and unbounded limits', async () => {
    const headers = { Authorization: `Bearer ${adminToken}` };
    await adminAgent.get('/api/auth/events').set(headers).query({ eventType: 'password' }).expect(400);
    await adminAgent.get('/api/auth/events').set(headers).query({ from: 'yesterday' }).expect(400);
    await adminAgent.get('/api/auth/events').set(headers).query({ limit: 201 }).expect(400);
  });
});
