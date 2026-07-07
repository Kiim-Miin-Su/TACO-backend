import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// [TBO-19 Sprint4] 강사 계약 조회 — 매니저 이상만(계약 시급 민감), 시드 2건.
describe('Instructor contracts (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
  });

  const token = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;

  it('매니저: 계약 목록 2건(강사1·2)', async () => {
    const admin = await token('admin');
    const list = (await http.get('/api/instructor-contracts').set({ Authorization: `Bearer ${admin}` }).expect(200)).body;
    expect(list.length).toBe(2);
    const c1 = list.find((c: { instructorId: number }) => c.instructorId === 1);
    expect(c1).toMatchObject({ monthlyHours: 40, hourlyRate: 50000, active: true });
  });

  it('강사: 계약 조회 차단(403 — 시급 민감)', async () => {
    const inst = await token('park_inst');
    await http.get('/api/instructor-contracts').set({ Authorization: `Bearer ${inst}` }).expect(403);
  });
});
