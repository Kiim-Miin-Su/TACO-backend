import { Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { INSTRUCTOR_CONTRACTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { InstructorContract, INSTRUCTOR_CONTRACTS } from './instructor-contract.entity';

// [TBO-19 Sprint4] 강사 계약 서비스 — 시드 + 조회(읽기 전용 첫 컷). CRUD·기간 계산은 후속(DB 이관 시).
@Injectable()
export class InstructorContractsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC);
  }

  findAll(): InstructorContract[] {
    return this.db.findAll<InstructorContract>(INSTRUCTOR_CONTRACTS);
  }

  // 강사의 현재 유효 계약(active). 없으면 undefined.
  findActive(instructorId: number): InstructorContract | undefined {
    return this.db.findBy<InstructorContract>(INSTRUCTOR_CONTRACTS, (c) => c.instructorId === instructorId && c.active)[0];
  }
}
