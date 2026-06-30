import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { AvailabilityBlock, AVAILABILITY, AvailabilityOwner } from './availability.entity';
import { UpsertAvailabilityDto } from './dto/upsert-availability.dto';
import { RoomsService } from '../rooms/rooms.service';

type Seed = Omit<AvailabilityBlock, 'id' | 'createdAt' | 'updatedAt'>;

@Injectable()
export class AvailabilityService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly rooms: RoomsService,
  ) {}

  // owner_id 참조 무결성(#7): room은 실제 테이블이므로 즉시 검증.
  // instructor/student는 데모 하드코딩이라 DB 승격 시 검증 추가(현재는 통과).
  private assertOwner(ownerType: AvailabilityOwner, ownerId: number): void {
    if (ownerType === 'room' && !this.rooms.findAll().some((r) => r.id === ownerId)) {
      throw new BadRequestException(`roomId ${ownerId} 없음(존재하지 않는 강의실)`);
    }
  }

  // 데모 가용/불가(Block) 시드. unavailable = 차단(주간 표에서 회색).
  onModuleInit(): void {
    if (this.db.findAll<AvailabilityBlock>(AVAILABILITY).length) return;
    const seed: Seed[] = [
      // 강사1 점심 차단(월~금 12:00–13:00)
      ...[1, 2, 3, 4, 5].map((wd) => ({ ownerType: 'instructor' as AvailabilityOwner, ownerId: 1, kind: 'unavailable' as const, weekday: wd, startTime: '12:00', endTime: '13:00' })),
      // 강의실 B201 금요일 오후 차단(행사)
      { ownerType: 'room', ownerId: 3, kind: 'unavailable', weekday: 5, startTime: '14:00', endTime: '18:00' },
      // 강사2 가용(화·목 16:00–20:00)
      { ownerType: 'instructor', ownerId: 2, kind: 'available', weekday: 2, startTime: '16:00', endTime: '20:00' },
      { ownerType: 'instructor', ownerId: 2, kind: 'available', weekday: 4, startTime: '16:00', endTime: '20:00' },
      // 강사1 가용(월·수·금 14:00–20:00) — 추천은 강사가 명시한 가용 안에서만 잡힘(무결성)
      { ownerType: 'instructor', ownerId: 1, kind: 'available', weekday: 1, startTime: '14:00', endTime: '20:00' },
      { ownerType: 'instructor', ownerId: 1, kind: 'available', weekday: 3, startTime: '14:00', endTime: '20:00' },
      { ownerType: 'instructor', ownerId: 1, kind: 'available', weekday: 5, startTime: '14:00', endTime: '20:00' },
    ];
    seed.forEach((b) => this.db.insert<AvailabilityBlock>(AVAILABILITY, b));
  }

  list(ownerType?: AvailabilityOwner, ownerId?: number): AvailabilityBlock[] {
    return this.db.findBy<AvailabilityBlock>(AVAILABILITY, (b) =>
      (ownerType ? b.ownerType === ownerType : true) && (ownerId ? b.ownerId === ownerId : true),
    );
  }

  upsert(dto: UpsertAvailabilityDto): AvailabilityBlock {
    this.assertOwner(dto.ownerType, dto.ownerId); // owner_id 참조 무결성(#7)
    if (dto.id) {
      const updated = this.db.update<AvailabilityBlock>(AVAILABILITY, dto.id, {
        kind: dto.kind ?? 'available',
        weekday: dto.weekday,
        startTime: dto.startTime,
        endTime: dto.endTime,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: dto.effectiveTo,
      });
      if (updated) return updated;
    }
    return this.db.insert<AvailabilityBlock>(AVAILABILITY, {
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      kind: dto.kind ?? 'available',
      weekday: dto.weekday,
      startTime: dto.startTime,
      endTime: dto.endTime,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
    });
  }

  remove(id: number): { id: number; deleted: boolean } {
    return { id, deleted: this.db.remove(AVAILABILITY, id) };
  }
}
