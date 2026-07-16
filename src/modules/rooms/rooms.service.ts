import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { ROOMS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { Room, ROOMS } from './room.entity';
import { CreateRoomDto } from './dto/create-room.dto';

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
    const hydrated = await this.store.hydrate<Room>(ROOMS_SPEC);
    if (hydrated.length || this.db.findAll<Room>(ROOMS).length) return;
    const seed: Array<Omit<Room, keyof import('../../database/in-memory.database').BaseRow> & { id: number }> = [
      { id: 1, name: 'A101', capacity: 8, color: '#0969da', isActive: true },
      { id: 2, name: 'A102', capacity: 6, color: '#1a7f37', isActive: true },
      { id: 3, name: 'B201 (세미나)', capacity: 16, color: '#8250df', isActive: true },
    ];
    await this.store.seed<Room>(ROOMS_SPEC, seed);
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
        capacity: dto.capacity,
        color: dto.color,
        isActive: dto.isActive ?? true,
      });
      // [감사 전수 2026-07-16] 전 테이블 CRUD 이력(대표 지시)
      if (actorId != null) await this.audit.log({ entity: 'rooms', entityId: row.id, action: 'create', actorId });
      return row;
    });
  }
}
