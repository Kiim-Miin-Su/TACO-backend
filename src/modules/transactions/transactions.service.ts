import { Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { TRANSACTIONS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { Transaction, TRANSACTIONS } from './transaction.entity';

@Injectable()
export class TransactionsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  // 데모 입·출금 원장 시드 — 프론트 목데이터 이관(대시보드 매출/지출).
  // 무결성: 강사 페이(instructor_payout) out은 payouts.pay가 실제로 기록하므로 여기서 시드하지 않는다
  //   (이중 계상 방지). 여기선 결제 입금·지출만 시드. 금액은 다른 시드와 정합:
  //   enrollment 480,000(코스10 정가/결제), re_enrollment 520,000(코스11), expense 86,000(지출#1).
  // 고정 id 101~103 — 런타임 pay가 nextId(1..)로 넣는 원장과 절대 충돌하지 않게. db.seed가 id별 멱등.
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Transaction>(TRANSACTIONS_SPEC);
  }

  findAll(): Transaction[] {
    return this.db.findAll<Transaction>(TRANSACTIONS);
  }
}
