import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ROOMS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Room, ROOMS } from './room.entity';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';

@Injectable()
export class RoomsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService,
  ) {}

  // 부팅 시 데모 강의실 시드(in-memory)
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<Room>(ROOMS_SPEC);
  }

  findAll(): Room[] {
    return this.db.findAll<Room>(ROOMS);
  }

  findOne(id: number): Room {
    const row = this.db.findById<Room>(ROOMS, id);
    if (!row) throw new NotFoundException(`Room ${id} not found`);
    return row;
  }

  // actorId 없으면(시드·내부 경로) audit 생략. 쓰기+audit 한 tx(uow).
  async create(dto: CreateRoomDto, actorId?: number): Promise<Room> {
    return this.uow.run(async () => {
      const row = await this.store.insert<Room>(ROOMS_SPEC, {
        name: dto.name,
        buildingId: dto.buildingId,
        capacity: dto.capacity ?? 1, // [B4 대표 결정 ②] 기본 정원 1명(1:1 수업 중심)
        color: dto.color,
        isActive: dto.isActive ?? true,
      });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'rooms', entityId: row.id, action: 'create', actorId });
      return row;
    });
  }

  /** [B4] 정원 리졸버 — 충돌 검사(conflict.util) 주입용. 미지정/미보유 방은 기본 1. */
  capacityOf(id: number): number | undefined {
    const row = this.db.findById<Room>(ROOMS, id);
    if (!row) return undefined; // 존재하지 않는 방은 FK 검증이 별도로 잡는다
    return row.capacity ?? 1;
  }

  // [B4] 강의실 수정(이름·정원·색·활성) — 매니저 이상(controller 게이트), diff audit 한 tx.
  async update(id: number, dto: UpdateRoomDto, actorId?: number): Promise<Room> {
    const before = { ...this.findOne(id) }; // live-reference 함정 방지(diff용 클론)
    return this.uow.run(async () => {
      const after = await this.store.update<Room>(ROOMS_SPEC, id, { ...dto }) as Room;
      // [감사 전수 2026-07-16] 정원 변경은 충돌 정책에 직결 — diff 이력 필수.
      if (actorId != null) {
        await this.audit.log({ entity: 'rooms', entityId: id, action: 'update', actorId, changes: this.audit.diffOf(before, after) });
      }
      return after;
    });
  }

  // [B4] 강의실 소프트 삭제 — 기존 세션 행은 보존(과거 이력), 신규 배정 select에서만 사라진다.
  async remove(id: number, actorId?: number): Promise<Room> {
    const before = { ...this.findOne(id) };
    return this.uow.run(async () => {
      await this.store.remove(ROOMS_SPEC, id, actorId);
      if (actorId != null) {
        await this.audit.log({ entity: 'rooms', entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf(before) });
      }
      return before;
    });
  }
}
