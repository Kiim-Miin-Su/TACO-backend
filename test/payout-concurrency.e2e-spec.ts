import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { assertExpectedAfter } from '../src/common/expected-after.util';
import { createTestApp } from './setup-app';

describe('payout concurrent transition integrity (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => app.close());

  it('동일 정산 동시 지급은 한 요청만 성공하고 원장 출금도 정확히 한 줄 생성한다', async () => {
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      sessionDate: '2099-12-20',
      startTime: '08:00',
      durationMinutes: 60,
      studentIds: [1],
      topic: '동시 지급 무결성',
      force: true,
    }).expect(201)).body.row;
    await http.patch(`/api/schedule/${session.id}`).set(auth()).send({ status: 'held', force: true }).expect(200);
    // [기간설정 ① 2026-07-24] 출결 미기록 = 이상(auto 제외) — 적격이 되려면 출결까지 완결
    await http.put('/api/attendance').set(auth()).send({ sessionId: session.id, studentId: 1, status: 'present' }).expect(200);
    const report = (await http.post('/api/reports').set(auth()).send({
      sessionId: session.id,
      studentId: 1,
      content: '동시 지급 검증 보고서',
    }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/approve`).set(auth()).expect(201);

    const payout = (await http.post('/api/payouts/generate').set(auth()).send({
      instructorId: 1,
      from: '2099-12-20',
      to: '2099-12-20',
    }).expect(201)).body;
    await http.post(`/api/payouts/${payout.id}/confirm`).set(auth()).expect(201);

    const responses = await Promise.all([
      http.post(`/api/payouts/${payout.id}/pay`).set(auth()),
      http.post(`/api/payouts/${payout.id}/pay`).set(auth()),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const payouts = (await http.get('/api/payouts').set(auth()).expect(200)).body;
    const afterPayout = payouts.find((row: { id: number }) => row.id === payout.id);
    const transactions = (await http.get('/api/transactions').set(auth()).expect(200)).body
      .filter((row: { payoutId?: number }) => row.payoutId === payout.id);
    assertExpectedAfter('동시 지급 expected/after', {
      status: 'paid',
      transactionCount: 1,
      transactionAmount: payout.amount,
    }, {
      status: afterPayout.status,
      transactionCount: transactions.length,
      transactionAmount: transactions[0]?.amount,
    });
  });
});
