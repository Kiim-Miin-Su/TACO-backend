import { Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { InstructorContract, INSTRUCTOR_CONTRACTS } from './instructor-contract.entity';

// [TBO-19 Sprint4] 강사 계약 서비스 — 시드 + 조회(읽기 전용 첫 컷). CRUD·기간 계산은 후속(DB 이관 시).
@Injectable()
export class InstructorContractsService implements OnModuleInit {
  constructor(private readonly db: InMemoryDatabase) {}

  // 데모 시드 — 강사 식별자 통일(instructorId=users.id): 1=박지훈, 2=정유진.
  onModuleInit(): void {
    this.db.seed<InstructorContract>(INSTRUCTOR_CONTRACTS, [
      { id: 1, instructorId: 1, monthlyHours: 40, hourlyRate: 50000, periodStart: '2026-03-01', active: true },
      { id: 2, instructorId: 2, monthlyHours: 32, hourlyRate: 60000, periodStart: '2026-03-01', active: true },
    ]);
  }

  findAll(): InstructorContract[] {
    return this.db.findAll<InstructorContract>(INSTRUCTOR_CONTRACTS);
  }

  // 강사의 현재 유효 계약(active). 없으면 undefined.
  findActive(instructorId: number): InstructorContract | undefined {
    return this.db.findBy<InstructorContract>(INSTRUCTOR_CONTRACTS, (c) => c.instructorId === instructorId && c.active)[0];
  }
}
