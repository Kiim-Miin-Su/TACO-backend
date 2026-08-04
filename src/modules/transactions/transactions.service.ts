import { TimedModuleInit } from '../../common/performance-timing';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { TRANSACTIONS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { Transaction, TRANSACTIONS } from './transaction.entity';

@TimedModuleInit()
@Injectable()
export class TransactionsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  // [TBO-79 G3] 이 메서드는 hydrate만 한다. 종전 주석은 고정 id 101~103 데모 원장 시드를
  //  설명했는데 그 시드는 이미 제거됐다(mock 시드 production 차단). 남아 있으면 감사자가
  //  존재하지 않는 데모 행을 찾게 된다.
  // 무결성 규약은 유효: 강사 페이(instructor_payout) out은 payouts.pay가 기록하므로 이 모듈이
  //  따로 넣지 않는다(이중 계상 방지).
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Transaction>(TRANSACTIONS_SPEC);
  }

  findAll(): Transaction[] {
    return this.db.findAll<Transaction>(TRANSACTIONS);
  }

  /** [TBO-54 C2] 목록 READ = DB 권위(다른 인스턴스의 수납·환불 원장도 즉시 반영). */
  listDb(): Promise<Transaction[]> {
    return this.store.findActive<Transaction>(TRANSACTIONS_SPEC, { orderBy: { field: 'id' } });
  }
}
