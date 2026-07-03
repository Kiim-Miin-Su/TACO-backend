import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 학원 이벤트(events) 모듈 e2e — 시드·캘린더 구간 무결성·권한.
describe('Events API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('GET /events — 시드 4건, 시작일 오름차순, 필드 정합', async () => {
    const rows = (await http.get('/api/events').set(asAdmin()).expect(200)).body;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    // 시작일 오름차순
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].startDate <= rows[i].startDate).toBe(true);
    // 캘린더 구간 무결성: 모든 이벤트 endDate ≥ startDate
    expect(rows.every((e: { startDate: string; endDate: string }) => e.endDate >= e.startDate)).toBe(true);
  });

  it('POST /events — 관리자 발행(priority 기본 normal)', async () => {
    const res = await http.post('/api/events').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ title: '가을 오리엔테이션', type: 'event', startDate: '2026-09-01', endDate: '2026-09-02' })
      .expect(201);
    expect(res.body).toMatchObject({ title: '가을 오리엔테이션', type: 'event', priority: 'normal' });
    expect(res.body.id).toBeGreaterThan(0);
  });

  it('POST /events — endDate < startDate → 400 (캘린더 구간 무결성)', async () => {
    await http.post('/api/events').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ title: '잘못된 구간', type: 'notice', startDate: '2026-09-10', endDate: '2026-09-05' })
      .expect(400);
  });

  it('POST /events — 잘못된 날짜 형식 → 400', async () => {
    await http.post('/api/events').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ title: 'x', type: 'notice', startDate: '2026/09/10', endDate: '2026-09-10' })
      .expect(400);
  });

  it('권한: 비로그인 발행 401 · 강사 403', async () => {
    await http.post('/api/events').send({ title: 'x', type: 'notice', startDate: '2026-09-01', endDate: '2026-09-01' }).expect(401);
    const inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.post('/api/events').set({ Authorization: `Bearer ${inst}` })
      .send({ title: 'x', type: 'notice', startDate: '2026-09-01', endDate: '2026-09-01' }).expect(403);
  });
});
