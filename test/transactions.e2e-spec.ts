import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 원장(transactions) 모듈 e2e — 시드 + 금액 정합.
describe('Transactions API (e2e)', () => {
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

  it('[통신 감사 2026-07-03] 원장은 비로그인 열람 불가(401) — 재무 정보 노출 차단 회귀', async () => {
    await http.get('/api/transactions').expect(401);
  });

  it('GET /transactions — 시드(입금·지출) + 필드·방향 정합', async () => {
    const rows = (await http.get('/api/transactions').set(asAdmin()).expect(200)).body;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((t: { label?: string; occurredAt?: string; direction: string }) =>
      t.label && t.occurredAt && (t.direction === 'in' || t.direction === 'out'))).toBe(true);
  });

  it('입금 합 1,000,000 (결제 입금 정합) · 강사페이 원장 이중계상 없음', async () => {
    const rows = (await http.get('/api/transactions').set(asAdmin()).expect(200)).body;
    const inSum = rows.filter((t: { direction: string }) => t.direction === 'in').reduce((a: number, t: { amount: number }) => a + t.amount, 0);
    expect(inSum).toBe(1_000_000); // 480,000 + 520,000 (enrollment + re_enrollment)
    // instructor_payout out은 payouts.pay가 실제로 1건만 기록(시드에서 중복 생성 안 함).
    const payoutTx = rows.filter((t: { category: string }) => t.category === 'instructor_payout');
    expect(payoutTx.length).toBeLessThanOrEqual(1);
  });
});
