import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { assertExpectedAfter } from '../src/common/expected-after.util';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AUDIT_LOG } from '../src/modules/audit/audit.service';
import { completeSessionByAttendance, createTestApp, sudoAuthHeaders } from './setup-app';

describe('payout concurrent transition integrity (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let token = '';
  const auth = () => sudoAuthHeaders(app, token);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => app.close());

  async function createPendingPayout(
    sessionDate: string,
    startTime: string,
    topic: string,
  ): Promise<{ id: number; amount: number }> {
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      sessionDate,
      startTime,
      durationMinutes: 60,
      studentIds: [1],
      topic,
      force: true,
    }).expect(201)).body.row;
    await completeSessionByAttendance(http, auth(), session.id, [1]);
    const report = (await http.post('/api/reports').set(auth()).send({
      sessionId: session.id,
      studentId: 1,
      content: `${topic} 보고서`,
    }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/approve`).set(auth()).expect(201);

    return (await http.post('/api/payouts/generate').set(auth()).send({
      instructorId: 1,
      from: sessionDate,
      to: sessionDate,
    }).expect(201)).body;
  }

  function payoutAudits(
    payoutId: number,
    action?: string,
  ): Array<{
    id: number;
    action: string;
    changes?: Record<string, { before?: unknown; after?: unknown }>;
  }> {
    return db.findBy<{
      id: number;
      entity: string;
      entityId: number;
      action: string;
      changes?: Record<string, { before?: unknown; after?: unknown }>;
      createdAt: string;
      updatedAt: string;
    }>(
      AUDIT_LOG,
      (row) => row.entity === 'instructor_payouts'
        && row.entityId === payoutId
        && (action == null || row.action === action),
    ).sort((left, right) => left.id - right.id);
  }

  async function payoutAfter(id: number): Promise<{
    id: number;
    status: string;
    amount: number;
    adjustedAmount?: number;
  }> {
    const payouts = (await http.get('/api/payouts').set(auth()).expect(200)).body;
    return payouts.find((row: { id: number }) => row.id === id);
  }

  it('동일 정산 동시 확정은 한 요청만 성공하고 승인 감사도 정확히 한 줄 생성한다', async () => {
    const payout = await createPendingPayout('2024-12-19', '08:00', '동시 확정 무결성');

    const responses = await Promise.all([
      http.post(`/api/payouts/${payout.id}/confirm`).set(auth()),
      http.post(`/api/payouts/${payout.id}/confirm`).set(auth()),
    ]);
    const after = await payoutAfter(payout.id);
    const approveAudits = payoutAudits(payout.id, 'approve');

    assertExpectedAfter('동시 확정 expected/after', {
      statuses: [201, 409],
      status: 'confirmed',
      amount: payout.amount,
      approveAuditCount: 1,
      approvedAmount: payout.amount,
    }, {
      statuses: responses.map((response) => response.status).sort(),
      status: after.status,
      amount: after.amount,
      approveAuditCount: approveAudits.length,
      approvedAmount: approveAudits[0]?.changes?.amount?.after,
    });
  });

  it('동시 adjust는 lock 후 fresh reread되어 감사 before/after가 끊김 없이 직렬화된다', async () => {
    const payout = await createPendingPayout('2024-12-20', '08:00', '동시 금액 조정 무결성');

    const responses = await Promise.all([
      http.post(`/api/payouts/${payout.id}/adjust`).set(auth()).send({ amount: 41000, reason: '첫 번째 경쟁 조정' }),
      http.post(`/api/payouts/${payout.id}/adjust`).set(auth()).send({ amount: 42000, reason: '두 번째 경쟁 조정' }),
    ]);
    const after = await payoutAfter(payout.id);
    const updateAudits = payoutAudits(payout.id, 'update');
    const firstAmount = updateAudits[0]?.changes?.amount;
    const secondAmount = updateAudits[1]?.changes?.amount;

    assertExpectedAfter('동시 adjust expected/after', {
      statuses: [201, 201],
      auditCount: 2,
      firstBefore: payout.amount,
      secondBeforeEqualsFirstAfter: true,
      finalEqualsLastAudit: true,
      status: 'pending',
    }, {
      statuses: responses.map((response) => response.status).sort(),
      auditCount: updateAudits.length,
      firstBefore: firstAmount?.before,
      secondBeforeEqualsFirstAfter: secondAmount?.before === firstAmount?.after,
      finalEqualsLastAudit: after.amount === secondAmount?.after,
      status: after.status,
    });
  });

  it('adjust와 confirm 경쟁은 둘 다 반영되어 확정 금액이 stale snapshot으로 되돌아가지 않는다', async () => {
    const payout = await createPendingPayout('2024-12-21', '08:00', '조정 확정 경쟁 무결성');

    const responses = await Promise.all([
      http.post(`/api/payouts/${payout.id}/adjust`).set(auth()).send({ amount: 43000, reason: '확정 직전 조정' }),
      http.post(`/api/payouts/${payout.id}/confirm`).set(auth()),
    ]);
    const paid = (await http.post(`/api/payouts/${payout.id}/pay`).set(auth()).expect(201)).body;
    const transactions = (await http.get('/api/transactions').set(auth()).expect(200)).body
      .filter((row: { payoutId?: number }) => row.payoutId === payout.id);

    assertExpectedAfter('adjust-confirm expected/after', {
      statuses: [201, 201],
      status: 'paid',
      amount: 43000,
      adjustedAmount: 43000,
      updateAuditCount: 1,
      approveAuditCount: 1,
      transactionCount: 1,
      transactionAmount: 43000,
    }, {
      statuses: responses.map((response) => response.status).sort(),
      status: paid.payout.status,
      amount: paid.payout.amount,
      adjustedAmount: paid.payout.adjustedAmount,
      updateAuditCount: payoutAudits(payout.id, 'update').length,
      approveAuditCount: payoutAudits(payout.id, 'approve').length,
      transactionCount: transactions.length,
      transactionAmount: transactions[0]?.amount,
    });
  });

  it('동일 정산 동시 지급은 한 요청만 성공하고 원장 출금도 정확히 한 줄 생성한다', async () => {
    const payout = await createPendingPayout('2024-12-22', '08:00', '동시 지급 무결성');
    await http.post(`/api/payouts/${payout.id}/confirm`).set(auth()).expect(201);

    const responses = await Promise.all([
      http.post(`/api/payouts/${payout.id}/pay`).set(auth()),
      http.post(`/api/payouts/${payout.id}/pay`).set(auth()),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const afterPayout = await payoutAfter(payout.id);
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
