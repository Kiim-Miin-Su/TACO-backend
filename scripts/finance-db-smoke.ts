import 'reflect-metadata';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

type PaymentRow = { id: number; status: string; dueAt?: string };
type ExpenseRow = { id: number; status: string; spentAt?: string; rejectedReason?: string };
type TransactionRow = { id: number; direction: string; category: string; paymentId?: number; expenseId?: number; payoutId?: number };
type PayoutRow = { id: number; status: string; periodStart: string; adjustedAmount?: number; amount: number; lines?: Array<{ sessionId: number }> };
type ScheduleRow = { id: number; payoutId?: number | null; instructorPayAmount?: number | null };
type ReportRow = { id: number; sessionId: number; studentId: number; approvalStatus?: string };

// [TBO-29C C5] 실 DB 스모크 자격증명 — CEO 실계정 전환(admin 비밀번호 교체·운영 demo 차단) 이후
//  하드코딩 demo1234는 로컬/시드 DB 전용이다. 실 Neon 게이트는 SMOKE_ADMIN_PASSWORD(admin)·
//  SMOKE_STAFF_PASSWORD(그 외 QA 계정)로 주입한다. 비밀번호는 로그/출력에 기록하지 않는다.
//  [실계정 2026-07-15] admin 첫 로그인 rotation 후에는 webId 자체가 바뀐다 —
//  SMOKE_ADMIN_WEBID로 새 아이디를 주입한다(미설정 시 'admin' — 로컬 시드 전용).
const SMOKE_ADMIN_WEBID = process.env.SMOKE_ADMIN_WEBID ?? 'admin';
const smokePassword = (webId: string): string =>
  webId === SMOKE_ADMIN_WEBID
    ? process.env.SMOKE_ADMIN_PASSWORD ?? process.env.SMOKE_STAFF_PASSWORD ?? 'demo1234'
    : process.env.SMOKE_STAFF_PASSWORD ?? 'demo1234';

async function login(http: ReturnType<typeof request>, webId: string): Promise<string> {
  const res = await http.post('/api/auth/login').send({ webId, password: smokePassword(webId) }).expect(201);
  return res.body.accessToken;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function requireEnv(): void {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for finance DB smoke');
  }
}

async function createApprovedHeldSession(
  http: ReturnType<typeof request>,
  token: string,
  date: string,
  topic: string,
): Promise<number> {
  const session = (await http.post('/api/schedule')
    .set(auth(token))
    .send({
      courseId: 10,
      instructorId: 1,
      roomId: 1,
      sessionDate: date,
      startTime: '07:00',
      endTime: '08:00',
      status: 'held',
      kind: 'class',
      mode: 'online',
      topic,
      studentIds: [1],
      force: true,
    })
    .expect(201)).body.row as { id: number };

  const createReport = await http.post('/api/reports')
    .set(auth(token))
    .send({
      sessionId: session.id,
      studentId: 1,
      instructorId: 1,
      content: `${topic} report`,
      status: 'submitted',
    });
  if (createReport.status !== 201 && createReport.status !== 409) {
    throw new Error(`report create failed (${createReport.status}): ${JSON.stringify(createReport.body)}`);
  }
  const report = createReport.status === 201
    ? createReport.body as ReportRow
    : ((await http.get(`/api/reports?sessionId=${session.id}`).set(auth(token)).expect(200)).body as ReportRow[])
      .find((row) => row.sessionId === session.id && row.studentId === 1);
  if (!report) throw new Error(`report for session ${session.id} not found after duplicate response`);
  if (report.approvalStatus !== 'approved') {
    await http.post(`/api/reports/${report.id}/approve`).set(auth(token)).expect(201);
  }
  return session.id;
}

async function main(): Promise<void> {
  requireEnv();

  const stamp = Date.now();
  const day = String((stamp % 20) + 1).padStart(2, '0');
  const paidPayoutDate = `2099-10-${day}`;
  const rejectedPayoutDate = `2099-11-${day}`;
  const paymentDue = `2099-12-${day}`;
  const expenseDate = `2099-12-${String(((stamp + 3) % 20) + 1).padStart(2, '0')}`;
  const tag = `TBO-25-25C-finance-smoke-${stamp}`;
  const rejectReason = `${tag} reject`;

  let paymentId = 0;
  let approvedExpenseId = 0;
  let rejectedExpenseId = 0;
  let paidPayoutId = 0;
  let rejectedPayoutId = 0;
  let paidSessionId = 0;
  let rejectedSessionId = 0;

  {
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    const http = request(app.getHttpServer());
    const admin = await login(http, SMOKE_ADMIN_WEBID);

    const payment = (await http.post('/api/payments')
      .set(auth(admin))
      .send({ studentId: 1, enrollmentId: 1, amount: 123456, paymentMethod: 'card', dueAt: paymentDue })
      .expect(201)).body as PaymentRow;
    paymentId = payment.id;
    await http.post(`/api/payments/${paymentId}/pay`).set(auth(admin)).expect(201);
    await http.post(`/api/payments/${paymentId}/pay`).set(auth(admin)).expect(400);
    await http.post(`/api/payments/${paymentId}/refund`).set(auth(admin)).expect(201);
    await http.post(`/api/payments/${paymentId}/refund`).set(auth(admin)).expect(400);

    const approvedExpense = (await http.post('/api/expenses')
      .set(auth(admin))
      .send({ title: `${tag} approved`, amount: 98765, category: 'supplies', spentAt: expenseDate })
      .expect(201)).body as ExpenseRow;
    approvedExpenseId = approvedExpense.id;
    await http.post(`/api/expenses/${approvedExpenseId}/approve`).set(auth(admin)).expect(201);
    await http.post(`/api/expenses/${approvedExpenseId}/approve`).set(auth(admin)).expect(400);
    await http.post(`/api/expenses/${approvedExpenseId}/reject`)
      .set(auth(admin))
      .send({ reason: rejectReason })
      .expect(400);

    const rejectedExpense = (await http.post('/api/expenses')
      .set(auth(admin))
      .send({ title: `${tag} rejected`, amount: 11111, category: 'books', spentAt: expenseDate })
      .expect(201)).body as ExpenseRow;
    rejectedExpenseId = rejectedExpense.id;
    await http.post(`/api/expenses/${rejectedExpenseId}/reject`)
      .set(auth(admin))
      .send({ reason: rejectReason })
      .expect(201);

    paidSessionId = await createApprovedHeldSession(http, admin, paidPayoutDate, `${tag} paid-payout-session`);
    const pendingPayout = (await http.post('/api/payouts/generate')
      .set(auth(admin))
      .send({ instructorId: 1, from: paidPayoutDate, to: paidPayoutDate })
      .expect(201)).body as PayoutRow;
    paidPayoutId = pendingPayout.id;
    await http.post(`/api/payouts/${paidPayoutId}/adjust`)
      .set(auth(admin))
      .send({ amount: 55555, reason: `${tag} adjust` })
      .expect(201);
    await http.post(`/api/payouts/${paidPayoutId}/confirm`).set(auth(admin)).expect(201);
    await http.post(`/api/payouts/${paidPayoutId}/pay`).set(auth(admin)).expect(201);

    rejectedSessionId = await createApprovedHeldSession(http, admin, rejectedPayoutDate, `${tag} rejected-payout-session`);
    const payoutToReject = (await http.post('/api/payouts/generate')
      .set(auth(admin))
      .send({ instructorId: 1, from: rejectedPayoutDate, to: rejectedPayoutDate })
      .expect(201)).body as PayoutRow;
    rejectedPayoutId = payoutToReject.id;
    await http.post(`/api/payouts/${rejectedPayoutId}/reject`)
      .set(auth(admin))
      .send({ reason: rejectReason })
      .expect(201);

    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const admin = await login(http, SMOKE_ADMIN_WEBID);

    const payments = (await http.get('/api/payments').set(auth(admin)).expect(200)).body as PaymentRow[];
    if (payments.find((row) => row.id === paymentId)?.status !== 'refunded') {
      throw new Error(`payment ${paymentId} refund status did not survive restart`);
    }

    const expenses = (await http.get('/api/expenses').set(auth(admin)).expect(200)).body as ExpenseRow[];
    if (expenses.find((row) => row.id === approvedExpenseId)?.status !== 'approved') {
      throw new Error(`approved expense ${approvedExpenseId} did not survive restart`);
    }
    if (expenses.find((row) => row.id === rejectedExpenseId)?.rejectedReason !== rejectReason) {
      throw new Error(`rejected expense ${rejectedExpenseId} reason did not survive restart`);
    }

    const payouts = (await http.get('/api/payouts').set(auth(admin)).expect(200)).body as PayoutRow[];
    const paid = payouts.find((row) => row.id === paidPayoutId);
    if (!paid || paid.status !== 'paid' || paid.adjustedAmount !== 55555 || paid.amount !== 55555) {
      throw new Error(`paid payout ${paidPayoutId} did not survive restart`);
    }
    const rejected = payouts.find((row) => row.id === rejectedPayoutId);
    if (!rejected || rejected.status !== 'rejected') {
      throw new Error(`rejected payout ${rejectedPayoutId} did not survive restart`);
    }

    const txs = (await http.get('/api/transactions').set(auth(admin)).expect(200)).body as TransactionRow[];
    const paymentTxs = txs.filter((tx) => tx.paymentId === paymentId);
    if (paymentTxs.length !== 2
      || paymentTxs.filter((tx) => tx.direction === 'in' && tx.category === 'enrollment').length !== 1
      || paymentTxs.filter((tx) => tx.direction === 'out' && tx.category === 'refund').length !== 1) {
      throw new Error(`payment ${paymentId} expected exactly one payment and one refund transaction, got ${JSON.stringify(paymentTxs)}`);
    }
    const expenseTxs = txs.filter((tx) => tx.expenseId === approvedExpenseId);
    if (expenseTxs.length !== 1 || expenseTxs[0].direction !== 'out' || expenseTxs[0].category !== 'expense') {
      throw new Error(`expense ${approvedExpenseId} expected exactly one outgoing transaction, got ${JSON.stringify(expenseTxs)}`);
    }
    if (!txs.some((tx) => tx.payoutId === paidPayoutId && tx.direction === 'out' && tx.category === 'instructor_payout')) {
      throw new Error(`payout ${paidPayoutId} transaction not found`);
    }

    const paidSchedule = ((await http.get(`/api/schedule?from=${paidPayoutDate}&to=${paidPayoutDate}`)
      .set(auth(admin))
      .expect(200)).body as ScheduleRow[]).find((row) => row.id === paidSessionId);
    if (!paidSchedule || paidSchedule.payoutId !== paidPayoutId || !paidSchedule.instructorPayAmount) {
      throw new Error(`paid payout session ${paidSessionId} was not linked after restart`);
    }
    const rejectedSchedule = ((await http.get(`/api/schedule?from=${rejectedPayoutDate}&to=${rejectedPayoutDate}`)
      .set(auth(admin))
      .expect(200)).body as ScheduleRow[]).find((row) => row.id === rejectedSessionId);
    if (!rejectedSchedule || rejectedSchedule.payoutId != null || rejectedSchedule.instructorPayAmount != null) {
      throw new Error(`rejected payout session ${rejectedSessionId} was not released after restart`);
    }
    await app.close();
  }

  console.log(JSON.stringify({
    ok: true,
    paymentId,
    approvedExpenseId,
    rejectedExpenseId,
    paidPayoutId,
    rejectedPayoutId,
    paidSessionId,
    rejectedSessionId,
  }));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
