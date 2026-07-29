import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { INSTRUCTOR_CONTRACTS_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { InstructorContract } from './instructor-contract.entity';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { StaffAccount } from '../users/user.entity';
import { CreateInstructorContractDto, UpdateInstructorContractDto } from './dto/instructor-contract.dto';
import { todayKst } from '../../common/time.util';

// [TBO-19 Sprint4] 강사 계약 서비스 — 조회(읽기 전용 첫 컷). CRUD·기간 계산은 후속(C8 ERP).
// [TBO-59 2026-07-24] READ = DB 권위(findActive) 전환 — 대표 지시 "특별한 이유 없으면 모두 DB 관리".
//  쓰기 경로가 없어 stale 위험은 없었으나 메모리 미러 직접 반환 예외를 제거해 read 규약을 통일한다
//  (users.service의 삭제 차단 판정은 이미 findActive — 이제 목록 조회까지 동일 원천).
@Injectable()
export class InstructorContractsService implements OnModuleInit {
  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC);
  }

  async findAll(instructorId?: number): Promise<InstructorContract[]> {
    return this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, {
      where: instructorId == null ? undefined : { instructorId },
      orderBy: { field: 'periodStart', direction: 'DESC' },
    });
  }

  async findOne(id: number): Promise<InstructorContract> {
    const [row] = await this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, {
      where: { id },
      limit: 1,
    });
    if (!row) throw new NotFoundException(`Instructor contract ${id} not found`);
    return row;
  }

  /** 강사의 현재 유효 계약(active). 없으면 undefined. */
  async findActiveContract(instructorId: number): Promise<InstructorContract | undefined> {
    const rows = await this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, {
      where: { instructorId, active: true } as Partial<InstructorContract>,
      limit: 1,
    });
    const today = todayKst();
    return rows.find((row) => row.periodStart <= today && (!row.periodEnd || row.periodEnd >= today));
  }

  async create(dto: CreateInstructorContractDto, actorId: number): Promise<InstructorContract> {
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'instructor', id: dto.instructorId }]);
      const [instructor] = await this.store.findActive<StaffAccount>(USERS_SPEC, {
        where: { id: dto.instructorId, role: 'instructor', status: 'active' } as Partial<StaffAccount>,
        limit: 1,
      });
      if (!instructor) throw new BadRequestException('활성 강사 계정이 아닙니다.');
      this.assertRange(dto.periodStart, dto.periodEnd);
      await this.assertNoOverlap(dto.instructorId, dto.periodStart, dto.periodEnd);
      const row = await this.store.insert<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, {
        instructorId: dto.instructorId,
        monthlyHours: dto.monthlyHours,
        hourlyRate: dto.hourlyRate,
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        active: true,
        memo: dto.memo?.trim() || null,
      });
      await this.audit.log({
        entity: 'instructor_contracts',
        entityId: row.id,
        action: 'create',
        actorId,
        changes: this.audit.snapshotOf(row),
        reason: '강사 계약 생성',
      });
      return row;
    });
  }

  async update(id: number, dto: UpdateInstructorContractDto, actorId: number): Promise<InstructorContract> {
    const initial = await this.findOne(id);
    return this.uow.run(async () => {
      await this.uow.lockTargets([{ kind: 'instructor', id: initial.instructorId }]);
      const current = await this.findOne(id);
      const patch = {
        ...(dto.monthlyHours === undefined ? {} : { monthlyHours: dto.monthlyHours }),
        ...(dto.hourlyRate === undefined ? {} : { hourlyRate: dto.hourlyRate }),
        ...(dto.periodStart === undefined ? {} : { periodStart: dto.periodStart }),
        ...(dto.periodEnd === undefined ? {} : { periodEnd: dto.periodEnd }),
        ...(dto.active === undefined ? {} : { active: dto.active }),
        ...(dto.memo === undefined ? {} : { memo: dto.memo?.trim() || null }),
      };
      if (!Object.keys(patch).length) throw new BadRequestException('변경할 계약 정보를 입력해 주세요.');
      const periodStart = patch.periodStart ?? current.periodStart;
      const periodEnd = patch.periodEnd === undefined ? current.periodEnd : patch.periodEnd;
      this.assertRange(periodStart, periodEnd);
      const active = patch.active ?? current.active;
      if (!active && !periodEnd) {
        throw new BadRequestException('계약 종료 시 종료일을 입력해 주세요.');
      }
      if (active) await this.assertNoOverlap(current.instructorId, periodStart, periodEnd, id);
      if (Object.entries(patch).every(([key, value]) => current[key as keyof InstructorContract] === value)) {
        throw new BadRequestException('현재 계약 정보와 동일합니다.');
      }
      const updated = await this.store.updateIf<InstructorContract>(
        INSTRUCTOR_CONTRACTS_SPEC,
        id,
        { updatedAt: current.updatedAt },
        patch,
      );
      if (!updated) throw new ConflictException('다른 사용자가 계약을 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.');
      await this.audit.log({
        entity: 'instructor_contracts',
        entityId: id,
        action: 'update',
        actorId,
        changes: this.audit.diffOf(current, updated),
        reason: dto.reason.trim(),
      });
      return updated;
    });
  }

  private assertRange(periodStart: string, periodEnd?: string | null): void {
    if (periodEnd && periodEnd < periodStart) {
      throw new BadRequestException('계약 종료일은 시작일보다 빠를 수 없습니다.');
    }
  }

  private async assertNoOverlap(
    instructorId: number,
    periodStart: string,
    periodEnd?: string | null,
    ignoreId?: number,
  ): Promise<void> {
    const rows = await this.store.findActive<InstructorContract>(INSTRUCTOR_CONTRACTS_SPEC, {
      where: { instructorId, active: true } as Partial<InstructorContract>,
    });
    const end = periodEnd ?? '9999-12-31';
    const overlap = rows.find((row) =>
      row.id !== ignoreId && row.periodStart <= end && (row.periodEnd ?? '9999-12-31') >= periodStart,
    );
    if (overlap) throw new ConflictException(`기존 활성 계약 #${overlap.id}의 기간과 겹칩니다.`);
  }
}
