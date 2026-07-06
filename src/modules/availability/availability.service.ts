import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { AuditService } from '../audit/audit.service';
import { AvailabilityBlock, AVAILABILITY, AvailabilityOwner } from './availability.entity';
import { UpsertAvailabilityDto } from './dto/upsert-availability.dto';
import { RoomsService } from '../rooms/rooms.service';

type Seed = Omit<AvailabilityBlock, 'id' | 'createdAt' | 'updatedAt'>;

@Injectable()
export class AvailabilityService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly audit: AuditService, // [TBO-16 Q3] 가용/불가 변경 이력
    private readonly rooms: RoomsService,
  ) {}

  // owner_id 참조 무결성(#7): room은 실제 테이블이므로 즉시 검증.
  // instructor/student는 데모 하드코딩이라 DB 승격 시 검증 추가(현재는 통과).
  private assertOwner(ownerType: AvailabilityOwner, ownerId: number): void {
    if (ownerType === 'room' && !this.rooms.findAll().some((r) => r.id === ownerId)) {
      throw new BadRequestException(`roomId ${ownerId} 없음(존재하지 않는 강의실)`);
    }
  }

  // 겹침 방지(버그2): 같은 오너·같은 요일에 시간이 겹치는 블록이 이미 있으면 거부(자기 자신 제외).
  // "이미 불가/가용으로 지정된 시간"을 중복 지정하지 못하게 한다. 겹친 상대 시각을 메시지에 담아 경고.
  private assertNoOverlap(dto: UpsertAvailabilityDto): void {
    const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const s = toMin(dto.startTime), e = toMin(dto.endTime);
    // 기간(effectiveFrom/effectiveTo)이 겹치는지 — 서로 다른 기간이면 같은 요일·시간이어도 공존 가능
    // ("이번만/앞으로" 분할 규칙). 미지정은 무한대(±)로 간주.
    const rangesOverlap = (aF?: string, aT?: string, bF?: string, bT?: string) =>
      (!aT || !bF || bF <= aT) && (!bT || !aF || aF <= bT);
    const clash = this.db.findBy<AvailabilityBlock>(AVAILABILITY, (b) =>
      b.id !== dto.id &&
      b.ownerType === dto.ownerType && b.ownerId === dto.ownerId && b.weekday === dto.weekday &&
      toMin(b.startTime) < e && s < toMin(b.endTime) &&
      rangesOverlap(dto.effectiveFrom, dto.effectiveTo, b.effectiveFrom, b.effectiveTo),
    )[0];
    if (clash) {
      const kindLabel = clash.kind === 'unavailable' ? '불가시간' : '가용시간';
      throw new ConflictException(`이미 지정된 ${kindLabel}(${clash.startTime}–${clash.endTime})과 겹칩니다.`);
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

  upsert(dto: UpsertAvailabilityDto, actorId?: number): AvailabilityBlock {
    // [버그수정 2026-07-06] 자정 크로스(end<=start) 거부 — 세션과 동일 규칙. 시차 입력은 FE가 분할 저장(splitKstBand).
    const asMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    if (asMin(dto.endTime) <= asMin(dto.startTime))
      throw new BadRequestException('종료 시각이 시작보다 빠릅니다(자정을 넘는 블록은 두 개로 나눠 저장하세요)');
    this.assertOwner(dto.ownerType, dto.ownerId); // owner_id 참조 무결성(#7)
    this.assertNoOverlap(dto); // 겹침 방지(버그2)
    if (dto.id) {
      // [취약점 수정 2026-07-03] id 지정 갱신은 **소유자 일치**를 강제 — 임의 id로 남의(다른
      //  강사·학생·강의실) 블록을 변조하는 크로스-오너 공격 차단. 소유자 이전은 삭제 후 재생성으로만.
      const existing = this.db.findById<AvailabilityBlock>(AVAILABILITY, dto.id);
      if (existing && (existing.ownerType !== dto.ownerType || Number(existing.ownerId) !== Number(dto.ownerId))) {
        throw new BadRequestException(
          `블록 소유자가 일치하지 않습니다 (id=${dto.id}는 ${existing.ownerType} ${existing.ownerId} 소유)`,
        );
      }
      const beforeSnap = existing ? { ...existing } : undefined;
      const updated = this.db.transaction(() => {
        const u = this.db.update<AvailabilityBlock>(AVAILABILITY, dto.id!, {
          kind: dto.kind ?? 'available',
          weekday: dto.weekday,
          startTime: dto.startTime,
          endTime: dto.endTime,
          effectiveFrom: dto.effectiveFrom,
          effectiveTo: dto.effectiveTo,
        });
        if (u && actorId != null && beforeSnap) {
          const diff = this.audit.diffOf(beforeSnap, u);
          if (Object.keys(diff).length)
            this.audit.log({ entity: AVAILABILITY, entityId: u.id, action: 'update', actorId, changes: diff });
        }
        return u;
      });
      if (updated) return updated;
    }
    return this.db.transaction(() => {
      const created = this.db.insert<AvailabilityBlock>(AVAILABILITY, {
        ownerType: dto.ownerType,
        ownerId: dto.ownerId,
        kind: dto.kind ?? 'available',
        weekday: dto.weekday,
        startTime: dto.startTime,
        endTime: dto.endTime,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: dto.effectiveTo,
      });
      if (actorId != null)
        this.audit.log({ entity: AVAILABILITY, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
  }

  // [v9] soft delete + before 스냅샷 audit(Q3) — 단일 tx
  remove(id: number, actorId?: number): { id: number; deleted: boolean } {
    const before = this.db.findById<AvailabilityBlock>(AVAILABILITY, id);
    return this.db.transaction(() => {
      const deleted = before ? this.db.remove(AVAILABILITY, id, actorId) : false;
      if (deleted && actorId != null && before)
        this.audit.log({ entity: AVAILABILITY, entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf({ ...before }) as never });
      return { id, deleted };
    });
  }
}
