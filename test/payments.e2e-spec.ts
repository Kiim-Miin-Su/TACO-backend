import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 결제(payments) 청구 정정(PATCH) e2e — 대표(CEO) 전용, 완료 원장 보존.
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

  it('PATCH /payments/:id — 수납 완료 건의 금액·수단·기한 변경은 원장 불일치 방지를 위해 거부', async () => {
    await http.patch('/api/payments/1').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ amount: 1 }).expect(400);
    await http.patch('/api/payments/1').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ paymentMethod: 'cash' }).expect(400);
    await http.patch('/api/payments/1').set({ Authorization: `Bearer ${ADMIN}` })
      .send({ dueAt: '2026-07-31' }).expect(400);
  });

  it('POST /payments — 학생·수강·납부자 관계 FK 불일치는 거부', async () => {
    await http.post('/api/payments').set(asAdmin())
      .send({ studentId: 99999, amount: 1000 }).expect(400);
    await http.post('/api/payments').set(asAdmin())
      .send({ studentId: 1, enrollmentId: 99999, amount: 1000 }).expect(400);
    await http.post('/api/payments').set(asAdmin())
      .send({ studentId: 1, enrollmentId: 2, amount: 1000 }).expect(400);
    await http.post('/api/payments').set(asAdmin())
      .send({ studentId: 1, payerParentId: 2, amount: 1000 }).expect(400);
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
