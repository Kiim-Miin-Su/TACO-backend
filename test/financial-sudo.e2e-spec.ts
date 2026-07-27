import { INestApplication } from '@nestjs/common';
import type { AuditLog } from '@kms545487/contracts';
import request from 'supertest';
import { BaseRow, InMemoryDatabase } from '../src/database/in-memory.database';
import { AUDIT_LOG } from '../src/modules/audit/audit.service';
import { Expense, EXPENSES } from '../src/modules/expenses/expense.entity';
import { Payment, PAYMENTS } from '../src/modules/payments/payment.entity';
import { Transaction, TRANSACTIONS } from '../src/modules/transactions/transaction.entity';
import { createTestApp, sudoAuthHeaders } from './setup-app';

describe('[TBO-74B] financial ledger commands require sudo (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin = '';
  let manager = '';
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (
      await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)
    ).body.accessToken;
    manager = (
      await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201)
    ).body.accessToken;
  });

  afterAll(async () => app.close());

  it('blocks payment collection before mutation, then commits payment, ledger, and audit together', async () => {
    const payment = (
      await http
        .post('/api/payments')
        .set('Authorization', `Bearer ${admin}`)
        .send({ studentId: 1, amount: 123_000, paymentMethod: 'card' })
        .expect(201)
    ).body as Payment;
    const endpoint = `/api/payments/${payment.id}/pay`;

    await http
      .post(endpoint)
      .set('Authorization', `Bearer ${admin}`)
      .expect(403)
      .then((response) => expect(response.body.code).toBe('SUDO_REQUIRED'));
    await http.post(endpoint).set(sudoAuthHeaders(app, manager)).expect(403);
    expect(db.findById<Payment>(PAYMENTS, payment.id)?.status).toBe('pending');
    expect(db.findBy<Transaction>(TRANSACTIONS, (row) => row.paymentId === payment.id)).toHaveLength(0);

    const paid = (
      await http.post(endpoint).set(sudoAuthHeaders(app, admin)).expect(201)
    ).body as Payment;
    expect(paid).toMatchObject({ status: 'paid', paidAmount: 123_000 });
    const ledger = db.findBy<Transaction>(TRANSACTIONS, (row) => row.paymentId === payment.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'in', amount: 123_000 });
    expect(
      db.findBy<AuditLog & BaseRow>(
        AUDIT_LOG,
        (row) => row.entity === 'payments' && row.entityId === payment.id && row.action === 'status_change',
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: 3 })]));

    await http.post(endpoint).set(sudoAuthHeaders(app, admin)).expect(400);
    expect(db.findBy<Transaction>(TRANSACTIONS, (row) => row.paymentId === payment.id)).toHaveLength(1);
  });

  it('blocks expense approval before mutation, then commits expense, ledger, and audit together', async () => {
    const expense = (
      await http
        .post('/api/expenses')
        .set('Authorization', `Bearer ${admin}`)
        .send({
          category: 'supplies',
          title: 'TBO-74B sudo 승인',
          amount: 77_000,
          spentAt: '2026-07-27',
          vendor: 'QA상사',
        })
        .expect(201)
    ).body as Expense;
    const endpoint = `/api/expenses/${expense.id}/approve`;

    await http
      .post(endpoint)
      .set('Authorization', `Bearer ${admin}`)
      .expect(403)
      .then((response) => expect(response.body.code).toBe('SUDO_REQUIRED'));
    await http.post(endpoint).set(sudoAuthHeaders(app, manager)).expect(403);
    expect(db.findById<Expense>(EXPENSES, expense.id)?.status).toBe('requested');
    expect(db.findBy<Transaction>(TRANSACTIONS, (row) => row.expenseId === expense.id)).toHaveLength(0);

    const approved = (
      await http.post(endpoint).set(sudoAuthHeaders(app, admin)).expect(201)
    ).body as Expense;
    expect(approved.status).toBe('approved');
    const ledger = db.findBy<Transaction>(TRANSACTIONS, (row) => row.expenseId === expense.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'out', amount: 77_000 });
    expect(
      db.findBy<AuditLog & BaseRow>(
        AUDIT_LOG,
        (row) => row.entity === 'expenses' && row.entityId === expense.id && row.action === 'approve',
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: 3 })]));

    await http.post(endpoint).set(sudoAuthHeaders(app, admin)).expect(400);
    expect(db.findBy<Transaction>(TRANSACTIONS, (row) => row.expenseId === expense.id)).toHaveLength(1);
  });
});
