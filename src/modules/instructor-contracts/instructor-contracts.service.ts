import { Injectable, OnModuleInit } from '@nestjs/common';
import { INSTRUCTOR_CONTRACTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { InstructorContract } from './instructor-contract.entity';

// [TBO-19 Sprint4] 강사 계약 서비스 — 조회(읽기 전용 첫 컷). CRUD·기간 계산은 후속(C8 ERP).
// [TBO-59 2026-07-24] READ = DB 권위(findActive) 전환 — 대표 지시 "특별한 이유 없으면 모두 DB 관리".
//  쓰기 경로가 없어 stale 위험은 없었으나 메모리 미러 직접 반환 예외를 제거해 read 규약을 통일한다
//  (users.service의 삭제 차단 판정은 이미 findActive — 이제 목록 조회까지 동일 원천).
@Injectable()
export class InstructorContractsService implements OnModuleInit {
  constructor(private readonly store: PostgresCollectionStore) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC);
  }

  async findAll(): Promise<InstructorContract[]> {
    return this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, { orderBy: { field: 'id' } });
  }

  /** 강사의 현재 유효 계약(active). 없으면 undefined. */
  async findActiveContract(instructorId: number): Promise<InstructorContract | undefined> {
    const rows = await this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, {
      where: { instructorId, active: true } as Partial<InstructorContract>,
      limit: 1,
    });
    return rows[0];
  }
}
