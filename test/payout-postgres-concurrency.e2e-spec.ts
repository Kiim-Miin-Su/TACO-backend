import { INestApplication } from '@nestjs/common';
import { assertExpectedAfter } from '../src/common/expected-after.util';
import {
  AUDIT_LOG_SPEC,
  INSTRUCTOR_PAYOUTS_SPEC,
  TRANSACTIONS_SPEC,
} from '../src/database/calendar-asset-specs';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { InstructorPayoutRow, TransactionRow } from '../src/modules/payouts/payout.entity';
import { PayoutsService } from '../src/modules/payouts/payouts.service';
import { createTestApp } from './setup-app';

const enabled = process.env.RUN_MONEY_RACE_E2E === '1';
const describePostgres = enabled ? describe : describe.skip;

type AuditRow = {
  id: number;
  entity: string;
  entityId: number;
  action: string;
  actorId: number;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  at: string;
  createdAt: string;
  updatedAt: string;
};

describePostgres('payout two-instance PostgreSQL concurrency (e2e)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let store: PostgresCollectionStore;
  let payoutsA: PayoutsService;
  let payoutsB: PayoutsService;

  beforeAll(async () => {
    process.env.TEST_BUSINESS_FIXTURES = '0';
    appA = await createTestApp();
    appB = await createTestApp();
    store = appA.get(PostgresCollectionStore);
    payoutsA = appA.get(PayoutsService);
    payoutsB = appB.get(PayoutsService);
  });

  afterAll(async () => {
    await appB?.close();
    await appA?.close();
  });

  async function pendingPayout(label: string): Promise<InstructorPayoutRow> {
    return store.insert<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, {
      instructorId: 1,
      periodStart: '2099-12-01',
      periodEnd: '2099-12-31',
      sessionCount: 0,
      totalMinutes: 0,
      computedAmount: 50000,
      amount: 50000,
      status: 'pending',
      lines: [],
      adjustReason: label,
    });
  }

  async function payoutAfter(id: number): Promise<InstructorPayoutRow> {
    const [row] = await store.findActive<InstructorPayoutRow>(INSTRUCTOR_PAYOUTS_SPEC, {
      where: { id } as Partial<InstructorPayoutRow>,
      limit: 1,
    });
    if (!row) throw new Error(`Payout ${id} not found after transition`);
    return row;
  }

  async function audits(id: number, action: string): Promise<AuditRow[]> {
    const rows = await store.findActive<AuditRow>(AUDIT_LOG_SPEC, {
      where: {
        entity: 'instructor_payouts',
        entityId: id,
        action,
      } as Partial<AuditRow>,
      orderBy: { field: 'id' },
    });
    return rows;
  }

  it('두 인스턴스 동시 confirm은 하나만 성공하고 승인 감사도 한 줄이다', async () => {
    const payout = await pendingPayout('pg concurrent confirm');
    const results = await Promise.allSettled([
      payoutsA.confirm(payout.id, 1),
      payoutsB.confirm(payout.id, 2),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    const after = await payoutAfter(payout.id);
    const approveAudits = await audits(payout.id, 'approve');

    assertExpectedAfter('PG concurrent confirm expected/after', {
      fulfilled: 1,
      rejected: 1,
      rejectedStatus: 409,
      status: 'confirmed',
      amount: 50000,
      approveAuditCount: 1,
    }, {
      fulfilled: fulfilled.length,
      rejected: rejected.length,
      rejectedStatus: (rejected[0] as PromiseRejectedResult | undefined)?.reason?.getStatus?.(),
      status: after.status,
      amount: after.amount,
      approveAuditCount: approveAudits.length,
    });
  });

  it('두 인스턴스 동시 adjust는 fresh DB revision을 이어 받아 lost update 감사가 없다', async () => {
    const payout = await pendingPayout('pg concurrent adjust');
    const results = await Promise.all([
      payoutsA.adjust(payout.id, 41000, 'PG 첫 조정', 1),
      payoutsB.adjust(payout.id, 42000, 'PG 둘째 조정', 2),
    ]);
    const after = await payoutAfter(payout.id);
    const updateAudits = await audits(payout.id, 'update');
    const first = updateAudits[0]?.changes?.amount;
    const second = updateAudits[1]?.changes?.amount;

    assertExpectedAfter('PG concurrent adjust expected/after', {
      resultCount: 2,
      auditCount: 2,
      firstBefore: 50000,
      secondBeforeEqualsFirstAfter: true,
      finalEqualsLastAudit: true,
      status: 'pending',
    }, {
      resultCount: results.length,
      auditCount: updateAudits.length,
      firstBefore: first?.before,
      secondBeforeEqualsFirstAfter: second?.before === first?.after,
      finalEqualsLastAudit: after.amount === second?.after,
      status: after.status,
    });
  });

  it('두 인스턴스 adjust-confirm 경쟁 후 지급은 최종 조정액으로 원장 한 줄만 남긴다', async () => {
    const payout = await pendingPayout('pg adjust-confirm');
    const transitions = await Promise.all([
      payoutsA.adjust(payout.id, 43000, 'PG 확정 직전 조정', 1),
      payoutsB.confirm(payout.id, 2),
    ]);
    const paid = await payoutsB.pay(payout.id, 2);
    const transactions = await store.findActive<TransactionRow>(TRANSACTIONS_SPEC, {
      where: { payoutId: payout.id } as Partial<TransactionRow>,
    });

    assertExpectedAfter('PG adjust-confirm-pay expected/after', {
      transitionCount: 2,
      status: 'paid',
      amount: 43000,
      adjustedAmount: 43000,
      transactionCount: 1,
      transactionAmount: 43000,
    }, {
      transitionCount: transitions.length,
      status: paid.payout.status,
      amount: paid.payout.amount,
      adjustedAmount: paid.payout.adjustedAmount,
      transactionCount: transactions.length,
      transactionAmount: transactions[0]?.amount,
    });
  });
});
