import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { ACADEMY_EVENTS_SPEC } from '../../database/calendar-asset-specs';
import { AuditService } from '../audit/audit.service';
import { AcademyEvent, ACADEMY_EVENTS } from './event.entity';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

/**
 * [TBO-29D 요구 ⑤⑥ 2026-07-15] 학원 공통 이벤트(입시 설명회·모의고사·휴원 등) —
 *  메모리 전용 → Postgres write-through 이관(발행분 재기동 유실 해소, migration 20260715_05).
 *  권한: 조회=로그인 직원 전원(강사 포함 — 캘린더 전체 뷰 공통 표시), CUD=매니저 이상(controller).
 *  무결성: endDate ≥ startDate(서비스 400 + DB CHECK 이중 방어). 생성/수정/삭제는 audit 포함 한 tx.
 */
@Injectable()
export class EventsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  // 데모 학원 이벤트 시드 — 고정 id 1~4로 하이드레이션 멱등(PG에 있으면 시드 생략).
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<AcademyEvent>(ACADEMY_EVENTS_SPEC);
  }

  findAll(): AcademyEvent[] {
    // 캘린더 표시 순서: 시작일 오름차순(동일 시작일이면 id).
    return this.db
      .findAll<AcademyEvent>(ACADEMY_EVENTS)
      .slice()
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.id - b.id));
  }

  // 무결성 게이트: 캘린더 구간이 유효해야 함(종료일 ≥ 시작일). 위반 시 400.
  async create(dto: CreateEventDto, actorId: number): Promise<AcademyEvent> {
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    return this.uow.run(async () => {
      const row = await this.store.insert<AcademyEvent>(ACADEMY_EVENTS_SPEC, {
        title: dto.title,
        type: dto.type,
        priority: dto.priority ?? 'normal',
        startDate: dto.startDate,
        endDate: dto.endDate,
        allDay: dto.allDay,
        memo: dto.memo,
      });
      await this.audit.log({ entity: 'academy_events', entityId: row.id, action: 'create', actorId });
      return row;
    });
  }

  // 부분 수정 — 병합 후 구간 재검증(부분 패치로 end<start 역전 방지). diff audit 포함 한 tx.
  async update(id: number, dto: UpdateEventDto, actorId: number): Promise<AcademyEvent> {
    return this.uow.run(async () => {
      const found = this.db.findById<AcademyEvent>(ACADEMY_EVENTS, id);
      if (!found) throw new NotFoundException(`이벤트 ${id} 없음`);
      const before = { ...found }; // [감사 전수 2026-07-16] live-reference 함정 — diff 공백 방지 클론
      const merged = { startDate: dto.startDate ?? before.startDate, endDate: dto.endDate ?? before.endDate };
      if (merged.endDate < merged.startDate) {
        throw new BadRequestException('endDate must be on or after startDate');
      }
      const after = (await this.store.update<AcademyEvent>(ACADEMY_EVENTS_SPEC, id, { ...dto })) as AcademyEvent;
      await this.audit.log({
        entity: 'academy_events', entityId: id, action: 'update', actorId,
        changes: this.audit.diffOf(before, after),
      });
      return after;
    });
  }

  // 소프트 삭제 — before 스냅샷 audit(복원 근거) 포함 한 tx.
  async remove(id: number, actorId: number): Promise<AcademyEvent> {
    return this.uow.run(async () => {
      const before = this.db.findById<AcademyEvent>(ACADEMY_EVENTS, id);
      if (!before) throw new NotFoundException(`이벤트 ${id} 없음`);
      await this.store.remove(ACADEMY_EVENTS_SPEC, id, actorId);
      await this.audit.log({
        entity: 'academy_events', entityId: id, action: 'delete', actorId,
        changes: this.audit.snapshotOf(before),
      });
      return before;
    });
  }
}
