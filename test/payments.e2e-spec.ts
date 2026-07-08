import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 결제(payments) 청구 정정(PATCH) e2e — 대표(CEO) 전용, 수납 완료여도 정정 허용.
describe('Payments PATCH (e2e)', () => {
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

  it('PATCH /payments/:id — 금액·기한 정정(관리자)', async () => {
    const r = (await http.patch('/api/payments/3').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ amount: 500000, dueAt: '2026-07-15' }).expect(200)).body;
    expect(r).toMatchObject({ id: 3, amount: 500000, dueAt: '2026-07-15' });
  });

  it('PATCH /payments/:id — 수납 완료 건도 정정 허용', async () => {
    const r = (await http.patch('/api/payments/1').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ memo: '정정: 카드 취소 후 재청구' }).expect(200)).body;
    expect(r.memo).toBe('정정: 카드 취소 후 재청구');
    expect(r.status).toBe('paid'); // 상태 불변
  });

  it('PATCH /payments/:id — 없는 결제 → 404', async () => {
    await http.patch('/api/payments/99999').set({ Authorization: `Bearer ${ADMIN}` }).send({ amount: 1 }).expect(404);
  });

  it('권한: 비로그인 401 · 강사 403', async () => {
    await http.patch('/api/payments/3').send({ amount: 1 }).expect(401);
    const inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.patch('/api/payments/3').set({ Authorization: `Bearer ${inst}` }).send({ amount: 1 }).expect(403);
  });
});
