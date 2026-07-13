import { BadRequestException, ConflictException, ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { AVAILABILITY_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { hhmmToMin, weekdayOf } from '../../common/time.util'; // [R-3 함수 통일]
import { AuditService } from '../audit/audit.service';
import { hasAdminRole } from '../auth/roles.decorator';
import { Student, STUDENTS } from '../students/student.entity';
import { StaffAccount, USERS } from '../users/user.entity';
import { AvailabilityBlock, AVAILABILITY, AvailabilityKind, AvailabilityOwner } from './availability.entity';
import { UpsertAvailabilityDto } from './dto/upsert-availability.dto';
import { RoomsService } from '../rooms/rooms.service';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { sessionEndMin } from '../schedule/conflict.util';

type Seed = Omit<AvailabilityBlock, 'id' | 'createdAt' | 'updatedAt'>;
type AvailabilityKindEx = AvailabilityKind | 'online_only';
type AvailabilityBlockEx = Omit<AvailabilityBlock, 'kind'> & { kind: AvailabilityKindEx };
export type AvailabilityImpact = {
  sessionId: number;
  sessionDate: string;
  startTime?: string;
  endTime?: string;
  reason: 'available_removed' | 'unavailable_overlap' | 'online_only_overlap';
};

const DEMO_AVAILABILITY: Array<Seed & { id: number }> = [
  // 강사1 점심 차단(월~금 12:00-13:00)
  ...[1, 2, 3, 4, 5].map((weekday, index) => ({ id: index + 1, ownerType: 'instructor' as AvailabilityOwner, ownerId: 1, kind: 'unavailable' as const, weekday, startTime: '12:00', endTime: '13:00' })),
  { id: 6, ownerType: 'room', ownerId: 3, kind: 'unavailable', weekday: 5, startTime: '14:00', endTime: '18:00' },
  { id: 7, ownerType: 'instructor', ownerId: 2, kind: 'available', weekday: 2, startTime: '16:00', endTime: '20:00' },
  { id: 8, ownerType: 'instructor', ownerId: 2, kind: 'available', weekday: 4, startTime: '16:00', endTime: '20:00' },
  { id: 9, ownerType: 'instructor', ownerId: 2, kind: 'online_only', weekday: 1, startTime: '20:00', endTime: '22:00' },
  { id: 10, ownerType: 'instructor', ownerId: 1, kind: 'available', weekday: 1, startTime: '14:00', endTime: '20:00' },
  { id: 11, ownerType: 'instructor', ownerId: 1, kind: 'available', weekday: 3, startTime: '14:00', endTime: '20:00' },
  { id: 12, ownerType: 'instructor', ownerId: 1, kind: 'available', weekday: 5, startTime: '14:00', endTime: '20:00' },
  // 두 강사 모두 불가/가용/온라인 전용 유형을 갖도록 빠진 유형 보완.
  { id: 101, ownerType: 'instructor', ownerId: 1, kind: 'online_only', weekday: 2, startTime: '20:00', endTime: '22:00' },
  { id: 102, ownerType: 'instructor', ownerId: 2, kind: 'unavailable', weekday: 5, startTime: '12:00', endTime: '13:00' },
  // 학생 4명 각각 가용/불가/온라인 전용 1건. 제한 블록은 현재 seed 수업과 겹치지 않는다.
  { id: 103, ownerType: 'student', ownerId: 1, kind: 'available', weekday: 1, startTime: '14:00', endTime: '20:00' },
  { id: 104, ownerType: 'student', ownerId: 1, kind: 'unavailable', weekday: 2, startTime: '10:00', endTime: '11:00' },
  { id: 105, ownerType: 'student', ownerId: 1, kind: 'online_only', weekday: 4, startTime: '20:00', endTime: '22:00' },
  { id: 106, ownerType: 'student', ownerId: 2, kind: 'available', weekday: 2, startTime: '14:00', endTime: '20:00' },
  { id: 107, ownerType: 'student', ownerId: 2, kind: 'unavailable', weekday: 3, startTime: '10:00', endTime: '11:00' },
  { id: 108, ownerType: 'student', ownerId: 2, kind: 'online_only', weekday: 5, startTime: '20:00', endTime: '22:00' },
  { id: 109, ownerType: 'student', ownerId: 3, kind: 'available', weekday: 3, startTime: '14:00', endTime: '20:00' },
  { id: 110, ownerType: 'student', ownerId: 3, kind: 'unavailable', weekday: 4, startTime: '10:00', endTime: '11:00' },
  { id: 111, ownerType: 'student', ownerId: 3, kind: 'online_only', weekday: 6, startTime: '20:00', endTime: '22:00' },
  { id: 112, ownerType: 'student', ownerId: 4, kind: 'available', weekday: 1, startTime: '14:00', endTime: '20:00' },
  { id: 113, ownerType: 'student', ownerId: 4, kind: 'unavailable', weekday: 5, startTime: '10:00', endTime: '11:00' },
  { id: 114, ownerType: 'student', ownerId: 4, kind: 'online_only', weekday: 0, startTime: '20:00', endTime: '22:00' },
];

@Injectable()
export class AvailabilityService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly audit: AuditService, // [TBO-16 Q3] 가용/불가 변경 이력
    private readonly rooms: RoomsService,
  ) {}

  // owner_id 참조 무결성(#7): owner 3종 모두 실제 컬렉션 기준으로 검증.
  private assertOwner(ownerType: AvailabilityOwner, ownerId: number): void {
    if (ownerType === 'room' && !this.rooms.findAll().some((r) => Number(r.id) === Number(ownerId))) {
      throw new BadRequestException(`roomId ${ownerId} 없음(존재하지 않는 강의실)`);
    }
    if (ownerType === 'instructor' && this.db.findById<StaffAccount>(USERS, ownerId)?.role !== 'instructor')
      throw new BadRequestException(`instructorId ${ownerId} 없음(존재하지 않는 강사)`);
    const student = ownerType === 'student' ? this.db.findById<Student>(STUDENTS, ownerId) : undefined;
    if (ownerType === 'student' && (!student || student.status === 'canceled'))
      throw new BadRequestException(`studentId ${ownerId} 없음(존재하지 않는 학생)`);
  }

  private assertActorOwner(ownerType: AvailabilityOwner, ownerId: number, actorId?: number, actorRoles?: string[]): void {
    if (hasAdminRole(actorRoles)) return;
    if (actorId == null) throw new ForbiddenException('로그인한 사용자만 가용/불가 블록을 변경할 수 있습니다.');
    if (ownerType !== 'instructor' || Number(ownerId) !== Number(actorId)) {
      throw new ForbiddenException('강사는 본인 강사 가용/불가 블록만 변경할 수 있습니다.');
    }
  }

  // 겹침 방지(버그2): 같은 오너·같은 요일에 시간이 겹치는 블록이 이미 있으면 거부(자기 자신 제외).
  // "이미 불가/가용으로 지정된 시간"을 중복 지정하지 못하게 한다. 겹친 상대 시각을 메시지에 담아 경고.
  private assertNoOverlap(dto: UpsertAvailabilityDto): void {
    const toMin = hhmmToMin; // [R-3] 공통 유틸(로컬 중복 제거)
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
      const clashKind = clash.kind as AvailabilityKindEx;
      const kindLabel = clashKind === 'unavailable' ? '불가시간' : clashKind === 'online_only' ? '온라인만 가능' : '가용시간';
      throw new ConflictException(`이미 지정된 ${kindLabel}(${clash.startTime}–${clash.endTime})과 겹칩니다.`);
    }
  }

  // 데모 가용/불가(Block) 시드. unavailable = 차단(주간 표에서 회색).
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<AvailabilityBlock>(AVAILABILITY_SPEC);
    const knownIds = new Set(hydrated.map((row) => row.id));
    const missing = DEMO_AVAILABILITY.filter((row) => !knownIds.has(row.id));
    if (missing.length) await this.store.seed<AvailabilityBlock>(AVAILABILITY_SPEC, missing);
  }

  async refresh(): Promise<void> {
    await this.store.hydrate<AvailabilityBlock>(AVAILABILITY_SPEC);
  }

  list(ownerType?: AvailabilityOwner, ownerId?: number): AvailabilityBlock[] {
    return this.db.findBy<AvailabilityBlock>(AVAILABILITY, (b) =>
      (ownerType ? b.ownerType === ownerType : true) && (ownerId ? b.ownerId === ownerId : true),
    );
  }

  findOne(id: number): AvailabilityBlock | undefined {
    return this.db.findById<AvailabilityBlock>(AVAILABILITY, id);
  }

  previewUpsertImpact(dto: UpsertAvailabilityDto): AvailabilityImpact[] {
    if (dto.ownerType !== 'instructor') return [];
    const existing = dto.id ? this.db.findById<AvailabilityBlock>(AVAILABILITY, dto.id) : undefined;
    const next: AvailabilityBlockEx = {
      id: dto.id ?? -1,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      kind: (dto.kind ?? 'available') as AvailabilityKindEx,
      weekday: dto.weekday,
      startTime: dto.startTime,
      endTime: dto.endTime,
      effectiveFrom: dto.effectiveFrom,
      effectiveTo: dto.effectiveTo,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
    };
    const impact = this.impactOfRestrictiveBlock(next);
    if (existing?.kind === 'available') impact.push(...this.impactOfAvailableRemoval(existing, next));
    return this.dedupeImpact(impact);
  }

  previewDeleteImpact(id: number): AvailabilityImpact[] {
    const existing = this.db.findById<AvailabilityBlock>(AVAILABILITY, id);
    if (!existing || existing.ownerType !== 'instructor') return [];
    return existing.kind === 'available' ? this.impactOfAvailableRemoval(existing, null) : [];
  }

  private impactSessionsForInstructor(ownerId: number, weekday: number, from?: string, to?: string): ClassSession[] {
    return this.db.findBy<ClassSession>(SESSIONS, (s) =>
      s.instructorId === ownerId &&
      weekdayOf(s.sessionDate) === weekday &&
      (!from || s.sessionDate >= from) &&
      (!to || s.sessionDate <= to) &&
      s.status !== 'canceled' && s.status !== 'no_show' &&
      !s.deletedAt,
    );
  }

  private impactOfRestrictiveBlock(b: AvailabilityBlockEx): AvailabilityImpact[] {
    if (b.kind === 'available') return [];
    const bS = hhmmToMin(b.startTime), bE = hhmmToMin(b.endTime);
    return this.impactSessionsForInstructor(Number(b.ownerId), b.weekday, b.effectiveFrom, b.effectiveTo)
      .filter((s) => this.sessionOverlapsBlock(s, bS, bE))
      .filter((s) => b.kind === 'unavailable' || (s.mode ?? 'in_person') !== 'online')
      .map((s) => ({
        sessionId: s.id,
        sessionDate: s.sessionDate,
        startTime: s.startTime,
        endTime: s.endTime,
        reason: b.kind === 'online_only' ? 'online_only_overlap' : 'unavailable_overlap',
      }));
  }

  private impactOfAvailableRemoval(before: AvailabilityBlock, after: AvailabilityBlockEx | null): AvailabilityImpact[] {
    const beforeS = hhmmToMin(before.startTime), beforeE = hhmmToMin(before.endTime);
    const afterS = after ? hhmmToMin(after.startTime) : 0;
    const afterE = after ? hhmmToMin(after.endTime) : 0;
    const afterCoversDate = (s: ClassSession) =>
      !!after && (!after.effectiveFrom || s.sessionDate >= after.effectiveFrom) && (!after.effectiveTo || s.sessionDate <= after.effectiveTo);
    return this.impactSessionsForInstructor(Number(before.ownerId), before.weekday, before.effectiveFrom, before.effectiveTo)
      .filter((s) => this.sessionOverlapsBlock(s, beforeS, beforeE))
      .filter((s) =>
        !after ||
        after.kind !== 'available' ||
        after.ownerType !== before.ownerType ||
        Number(after.ownerId) !== Number(before.ownerId) ||
        after.weekday !== before.weekday ||
        !afterCoversDate(s) ||
        !this.sessionOverlapsBlock(s, afterS, afterE))
      .map((s) => ({ sessionId: s.id, sessionDate: s.sessionDate, startTime: s.startTime, endTime: s.endTime, reason: 'available_removed' }));
  }

  private sessionOverlapsBlock(s: ClassSession, bS: number, bE: number): boolean {
    if (!s.startTime) return false;
    const sS = hhmmToMin(s.startTime);
    const sE = sessionEndMin(s.startTime, s.endTime, s.durationMinutes);
    return sS < bE && bS < Math.min(sE, 1440);
  }

  private dedupeImpact(items: AvailabilityImpact[]): AvailabilityImpact[] {
    const seen = new Set<number>();
    return items.filter((x) => {
      if (seen.has(x.sessionId)) return false;
      seen.add(x.sessionId);
      return true;
    });
  }

  private assertApprovalNotRequired(dto: UpsertAvailabilityDto, actorRoles?: string[]): void {
    if (hasAdminRole(actorRoles)) return;
    const impacted = this.previewUpsertImpact(dto);
    if (impacted.length)
      throw new ConflictException({ message: '매니저 승인 필요', approvalRequired: true, impactedSessions: impacted });
  }

  private assertDeleteApprovalNotRequired(id: number, actorRoles?: string[]): void {
    if (hasAdminRole(actorRoles)) return;
    const impacted = this.previewDeleteImpact(id);
    if (impacted.length)
      throw new ConflictException({ message: '매니저 승인 필요', approvalRequired: true, impactedSessions: impacted });
  }

  validateRequestableUpsert(dto: UpsertAvailabilityDto, actorId?: number, actorRoles?: string[]): void {
    const asMin = hhmmToMin;
    if (asMin(dto.endTime) <= asMin(dto.startTime))
      throw new BadRequestException('종료 시각이 시작보다 빠릅니다(자정을 넘는 블록은 두 개로 나눠 저장하세요)');
    this.assertOwner(dto.ownerType, dto.ownerId);
    this.assertActorOwner(dto.ownerType, dto.ownerId, actorId, actorRoles);
    this.assertNoOverlap(dto);
  }

  async upsert(dto: UpsertAvailabilityDto, actorId?: number, actorRoles?: string[]): Promise<AvailabilityBlock> {
    await this.refresh();
    // [버그수정 2026-07-06] 자정 크로스(end<=start) 거부 — 세션과 동일 규칙. 시차 입력은 FE가 분할 저장(splitKstBand).
    const asMin = hhmmToMin; // [R-3] 공통 유틸(로컬 중복 제거)
    if (asMin(dto.endTime) <= asMin(dto.startTime))
      throw new BadRequestException('종료 시각이 시작보다 빠릅니다(자정을 넘는 블록은 두 개로 나눠 저장하세요)');
    this.validateRequestableUpsert(dto, actorId, actorRoles); // owner·IDOR·겹침 검증(요청 생성 경로와 동일)
    this.assertApprovalNotRequired(dto, actorRoles); // [TBO-22 C2] 수업 영향 가용 변경은 승인 요청으로 전환
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
      const updated = await this.db.transaction(async () => {
        const u = await this.store.update<AvailabilityBlock>(AVAILABILITY_SPEC, dto.id!, {
          kind: (dto.kind ?? 'available') as AvailabilityKind,
          weekday: dto.weekday,
          startTime: dto.startTime,
          endTime: dto.endTime,
          effectiveFrom: dto.effectiveFrom,
          effectiveTo: dto.effectiveTo,
        });
        if (u && actorId != null && beforeSnap) {
          const diff = this.audit.diffOf(beforeSnap, u);
          if (Object.keys(diff).length)
            await this.audit.log({ entity: AVAILABILITY, entityId: u.id, action: 'update', actorId, changes: diff });
        }
        return u;
      });
      if (updated) return updated;
    }
    return this.db.transaction(async () => {
      const created = await this.store.insert<AvailabilityBlock>(AVAILABILITY_SPEC, {
        ownerType: dto.ownerType,
        ownerId: dto.ownerId,
        kind: (dto.kind ?? 'available') as AvailabilityKind,
        weekday: dto.weekday,
        startTime: dto.startTime,
        endTime: dto.endTime,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: dto.effectiveTo,
      });
      if (actorId != null)
        await this.audit.log({ entity: AVAILABILITY, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
  }

  // [v9] soft delete + before 스냅샷 audit(Q3) — 단일 tx
  async remove(id: number, actorId?: number, actorRoles?: string[]): Promise<{ id: number; deleted: boolean }> {
    await this.refresh();
    const before = this.db.findById<AvailabilityBlock>(AVAILABILITY, id);
    if (before) this.assertActorOwner(before.ownerType, before.ownerId, actorId, actorRoles);
    this.assertDeleteApprovalNotRequired(id, actorRoles);
    return this.db.transaction(async () => {
      const deleted = before ? await this.store.remove(AVAILABILITY_SPEC, id, actorId) : false;
      if (deleted && actorId != null && before)
        await this.audit.log({ entity: AVAILABILITY, entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf({ ...before }) as never });
      return { id, deleted };
    });
  }
}
