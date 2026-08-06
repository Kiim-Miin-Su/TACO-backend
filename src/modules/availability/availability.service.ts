import { TimedModuleInit } from '../../common/performance-timing';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { AVAILABILITY_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { addDaysISO, hhmmToMin, weekdayOf } from '../../common/time.util'; // [R-3 함수 통일]
import { AuditService } from '../audit/audit.service';
import { hasAdminRole } from '../auth/roles.decorator';
import { Student, STUDENTS } from '../students/student.entity';
import { isScheduleVisibleStudentStatus } from '../students/student-status.policy';
import { StaffAccount, USERS, isActiveScheduleOwner } from '../users/user.entity';
import { AvailabilityBlock, AVAILABILITY, AvailabilityOwner } from './availability.entity';
import { UpsertAvailabilityDto } from './dto/upsert-availability.dto';
import { RoomsService } from '../rooms/rooms.service';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { buildCohortIndex } from '../schedule/session-participant.policy'; // [TBO-80 80C] 활성 코호트 규칙 SSOT
import { sessionEndMin } from '../schedule/conflict.util';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { ENROLLMENTS_SPEC, ROOMS_SPEC, STUDENTS_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import type { AvailabilityImpact } from '@kms545487/contracts';
export type { AvailabilityImpact } from '@kms545487/contracts';

@TimedModuleInit()
@Injectable()
export class AvailabilityService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly audit: AuditService, // [TBO-16 Q3] 가용/불가 변경 이력
    private readonly rooms: RoomsService,
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly sessions: ClassSessionsStore, // [TBO-29C C1] 잠금 후 세션 투영 권위 재조회(DatabaseModule @Global)
  ) {}

  // owner_id 참조 무결성(#7): owner 3종 모두 실제 컬렉션 기준으로 검증.
  private assertOwner(ownerType: AvailabilityOwner, ownerId: number): void {
    if (ownerType === 'room' && !this.rooms.findAll().some((r) => Number(r.id) === Number(ownerId))) {
      throw new BadRequestException(`roomId ${ownerId} 없음(존재하지 않는 강의실)`);
    }
    if (ownerType === 'instructor' && !isActiveScheduleOwner(this.db.findById<StaffAccount>(USERS, ownerId)))
      throw new BadRequestException(`instructorId ${ownerId} 없음(활성 강사 또는 대표 아님)`);
    const student = ownerType === 'student' ? this.db.findById<Student>(STUDENTS, ownerId) : undefined;
    if (ownerType === 'student' && (!student || !isScheduleVisibleStudentStatus(student.status)))
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
      const clashKind = clash.kind;
      const kindLabel = clashKind === 'unavailable' ? '불가시간' : clashKind === 'online_only' ? '온라인만 가능' : '가용시간';
      throw new ConflictException(`이미 지정된 ${kindLabel}(${clash.startTime}–${clash.endTime})과 겹칩니다.`);
    }
  }

  // 데모 가용/불가(Block) 시드. unavailable = 차단(주간 표에서 회색).
  //  [버그수정 2026-07-15] 기존엔 "누락 id만" 매 부팅 재시드 → 지운 데모 행이 계속 부활 +
  //  운영 DB에도 유입(전수 인벤토리 최다 위반). 이제 **표가 비어 있을 때만** 시드한다
  //  (production은 store.seed 단일 관문이 추가 차단).
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<AvailabilityBlock>(AVAILABILITY_SPEC);
  }

  async refresh(): Promise<void> {
    await this.store.hydrate<AvailabilityBlock>(AVAILABILITY_SPEC);
  }

  /** [TBO-29C C1] 잠금 후 권위 재조회 — 검증(owner 존재/겹침/impact)이 읽는 모든 투영을 최신화.
   *  availability(겹침) · sessions(impact·schedule create와 교차 경쟁) · users/students/rooms(owner 존재)
   *  · enrollments(학생의 코스 세션 역추적). 단일 PG 커넥션 tx 안이므로 순차 실행(병렬 query 금지). */
  private async refreshAuthoritative(): Promise<void> {
    // [C5 성능 수정] pg tx 안=순차(단일 커넥션) · 밖=병렬(Neon WAN 왕복 합산 방지 — db-crud 실측).
    const tasks = [
      () => this.store.hydrate<AvailabilityBlock>(AVAILABILITY_SPEC),
      () => this.sessions.ensureReady(),
      () => this.store.hydrate<StaffAccount>(USERS_SPEC),
      () => this.store.hydrate<Student>(STUDENTS_SPEC),
      () => this.store.hydrate(ROOMS_SPEC),
      () => this.store.hydrate<Enrollment>(ENROLLMENTS_SPEC),
    ];
    if (this.unitOfWork.inPgTransaction) {
      for (const task of tasks) await task();
    } else {
      await Promise.all(tasks.map((task) => task()));
    }
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
    const existing = dto.id ? this.db.findById<AvailabilityBlock>(AVAILABILITY, dto.id) : undefined;
    const next: AvailabilityBlock = {
      id: dto.id ?? -1,
      ownerType: dto.ownerType,
      ownerId: dto.ownerId,
      kind: dto.kind ?? 'available',
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
    if (!existing) return [];
    return existing.kind === 'available' ? this.impactOfAvailableRemoval(existing, null) : [];
  }

  // [TBO-28C] 세션의 (날짜, 요일, 시작분, 종료분) 세그먼트 — 자정 크로스는 **익일 세그먼트 포함**.
  //  구 구현은 시작일 요일만 보고 종료를 24:00에 캡해, 익일로 넘어간 구간이 제한 블록(불가/온라인만)
  //  impact 검사에서 누락됐다(conflict.util은 이미 이틀 검사 — 여기와 규칙 통일).
  private sessionSegments(s: ClassSession): Array<{ date: string; weekday: number; s: number; e: number }> {
    if (!s.startTime) return [];
    const sS = hhmmToMin(s.startTime);
    const sE = sessionEndMin(s.startTime, s.endTime, s.durationMinutes);
    const segs = [{ date: s.sessionDate, weekday: weekdayOf(s.sessionDate), s: sS, e: Math.min(sE, 1440) }];
    if (sE > 1440) {
      const next = addDaysISO(s.sessionDate, 1);
      segs.push({ date: next, weekday: weekdayOf(next), s: 0, e: sE - 1440 });
    }
    return segs;
  }

  private ownerSessions(ownerType: AvailabilityOwner, ownerId: number): ClassSession[] {
    // [TBO-80 80C] 활성 판정을 인라인 `status === 'active'`로 재선언하지 않는다 — 학생 행만 골라
    //  정책(buildCohortIndex)에 활성 여부를 위임하면 keys가 곧 그 학생의 활성 코스 집합이다.
    const studentCourseIds = ownerType === 'student'
      ? new Set(buildCohortIndex(this.db.findBy<Enrollment>(ENROLLMENTS, (e) => e.studentId === ownerId)).keys())
      : null;
    return this.db.findBy<ClassSession>(SESSIONS, (s) =>
      (ownerType === 'instructor'
        ? s.instructorId === ownerId
        : ownerType === 'room'
          ? s.roomId === ownerId
          : !!studentCourseIds?.has(s.courseId) || !!s.studentIds?.includes(ownerId)) &&
      s.status !== 'canceled' && s.status !== 'no_show' &&
      !s.deletedAt,
    );
  }

  /** 세션의 어떤 세그먼트가 블록(요일·시간·effective 기간)과 겹치는가 — 자정 크로스 익일 스필 포함. */
  private segmentsHitBlock(s: ClassSession, b: { weekday: number; startTime: string; endTime: string; effectiveFrom?: string; effectiveTo?: string }): boolean {
    const bS = hhmmToMin(b.startTime), bE = hhmmToMin(b.endTime);
    return this.sessionSegments(s).some((seg) =>
      seg.weekday === b.weekday &&
      (!b.effectiveFrom || seg.date >= b.effectiveFrom) &&
      (!b.effectiveTo || seg.date <= b.effectiveTo) &&
      seg.s < bE && bS < seg.e,
    );
  }

  private impactOfRestrictiveBlock(b: AvailabilityBlock): AvailabilityImpact[] {
    if (b.kind === 'available') return [];
    return this.ownerSessions(b.ownerType, Number(b.ownerId))
      .filter((s) => this.segmentsHitBlock(s, b))
      .filter((s) => b.kind === 'unavailable' || (s.mode ?? 'in_person') !== 'online')
      .map((s) => this.impactOfSession(
        s,
        b.kind === 'online_only' ? 'online_only_overlap' : 'unavailable_overlap',
      ));
  }

  private impactOfAvailableRemoval(before: AvailabilityBlock, after: AvailabilityBlock | null): AvailabilityImpact[] {
    return this.ownerSessions(before.ownerType, Number(before.ownerId))
      .filter((s) => this.segmentsHitBlock(s, before))
      .filter((s) =>
        !after ||
        after.kind !== 'available' ||
        after.ownerType !== before.ownerType ||
        Number(after.ownerId) !== Number(before.ownerId) ||
        !this.segmentsHitBlock(s, after))
      .map((s) => this.impactOfSession(s, 'available_removed'));
  }

  private impactOfSession(s: ClassSession, reason: AvailabilityImpact['reason']): AvailabilityImpact {
    const instructor = s.instructorId == null ? undefined : this.db.findById<StaffAccount>(USERS, s.instructorId);
    return {
      sessionId: s.id,
      sessionDate: s.sessionDate,
      startTime: s.startTime,
      endTime: s.endTime,
      instructorId: s.instructorId ?? undefined,
      instructorName: instructor?.name,
      courseId: s.courseId,
      topic: s.topic,
      reason,
    };
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
    const impacted = this.previewUpsertImpact(dto);
    if (!impacted.length) return;
    if (!hasAdminRole(actorRoles)) {
      throw new ConflictException({ message: '매니저 승인 필요', approvalRequired: true, impactedSessions: impacted });
    }
    const restrictive = impacted.filter((row) => row.reason !== 'available_removed');
    if (!restrictive.length) return;
    const first = restrictive[0];
    const instructor = first.instructorName ?? (first.instructorId != null ? `강사 #${first.instructorId}` : '담당 강사');
    const topic = first.topic?.trim() ? `"${first.topic}"` : `수업 #${first.sessionId}`;
    throw new ConflictException({
      message: `${instructor}의 ${topic} 수업 #${first.sessionId} (${first.sessionDate} ${first.startTime ?? '—'}–${first.endTime ?? '—'})과 겹쳐 저장할 수 없습니다. 먼저 수업을 변경하거나 취소해 주세요.`,
      approvalRequired: false,
      impactedSessions: restrictive,
    });
  }

  private assertDeleteApprovalNotRequired(id: number, actorRoles?: string[]): void {
    if (hasAdminRole(actorRoles)) return;
    const impacted = this.previewDeleteImpact(id);
    if (impacted.length)
      throw new ConflictException({ message: '매니저 승인 필요', approvalRequired: true, impactedSessions: impacted });
  }

  /** [취약점 수정 2026-07-03 · C1 통합] id 지정 갱신은 **소유자 일치** 강제 — 임의 id로 남의(다른
   *  강사·학생·강의실) 블록을 변조하는 크로스-오너 공격 차단. 소유자 이전은 삭제 후 재생성으로만.
   *  반환 = 기존 블록(update 판별·post-lock before 스냅샷용). */
  private assertOwnerMatch(dto: UpsertAvailabilityDto): AvailabilityBlock | undefined {
    if (!dto.id) return undefined;
    const existing = this.db.findById<AvailabilityBlock>(AVAILABILITY, dto.id);
    if (existing && (existing.ownerType !== dto.ownerType || Number(existing.ownerId) !== Number(dto.ownerId))) {
      throw new BadRequestException(
        `블록 소유자가 일치하지 않습니다 (id=${dto.id}는 ${existing.ownerType} ${existing.ownerId} 소유)`,
      );
    }
    return existing;
  }

  /** 요청 생성/수정 경로 검증 — 시간/owner 존재/IDOR/소유자 일치/겹침. impact(승인 게이트)는 제외:
   *  승인 요청 자체가 impact를 다루는 경로라 요청은 impact가 있어도 유효하다. */
  validateRequestableUpsert(dto: UpsertAvailabilityDto, actorId?: number, actorRoles?: string[]): void {
    const asMin = hhmmToMin;
    // [버그수정 2026-07-06] 자정 크로스(end<=start) 거부 — 세션과 동일 규칙. 시차 입력은 FE가 분할 저장(splitKstBand).
    if (asMin(dto.endTime) <= asMin(dto.startTime))
      throw new BadRequestException('종료 시각이 시작보다 빠릅니다(자정을 넘는 블록은 두 개로 나눠 저장하세요)');
    this.assertOwner(dto.ownerType, dto.ownerId);
    this.assertActorOwner(dto.ownerType, dto.ownerId, actorId, actorRoles);
    this.assertOwnerMatch(dto);
    this.assertNoOverlap(dto);
  }

  /** [TBO-29C C1] 직접 쓰기 경로의 **단일 권위 검증** — 시간/owner 존재/IDOR/소유자 일치/겹침/impact를
   *  한 함수로 통일. 쓰기 경로는 반드시 owner lock + refreshAuthoritative() **후에** 호출해야 판정이
   *  권위다(잠금 대기 중 다른 커밋이 겹침·impact를 바꿀 수 있음 — 기존 결함: lock 후 impact만 재검사).
   *  잠금 전 호출은 fail-fast 용도로만 쓴다. 반환 = dto.id의 기존 블록(post-lock before 스냅샷). */
  validateAuthoritativeUpsert(dto: UpsertAvailabilityDto, actorId?: number, actorRoles?: string[]): AvailabilityBlock | undefined {
    this.validateRequestableUpsert(dto, actorId, actorRoles);
    this.assertApprovalNotRequired(dto, actorRoles); // [TBO-22 C2] 수업 영향 가용 변경은 승인 요청으로 전환
    return dto.id ? this.db.findById<AvailabilityBlock>(AVAILABILITY, dto.id) : undefined;
  }

  // [TBO-29C C1] create/update 공통 순서: owner lock -> 권위 재조회(전 투영) -> 전체 재검증 -> write+audit.
  //  구 구현은 잠금 후 assertApprovalNotRequired만 재실행해, 잠금 대기 중 커밋된 겹침 블록을 보지 못하고
  //  둘 다 저장될 수 있었다(같은 owner 겹침 동시 쓰기 = 성공 1 · 409 1이 계약).
  async upsert(dto: UpsertAvailabilityDto, actorId?: number, actorRoles?: string[]): Promise<AvailabilityBlock> {
    await this.refresh();
    this.validateAuthoritativeUpsert(dto, actorId, actorRoles); // 잠금 전 fail-fast(권위 판정은 잠금 후 재실행)
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([{ kind: dto.ownerType, id: Number(dto.ownerId) }]);
      await this.refreshAuthoritative();
      const existing = this.validateAuthoritativeUpsert(dto, actorId, actorRoles); // 잠금 후 전체 재검증(권위)
      if (dto.id && existing) {
        const beforeSnap = { ...existing }; // [C1] before 스냅샷도 잠금 후 재조회 — stale audit 차단
        const updated = await this.store.update<AvailabilityBlock>(AVAILABILITY_SPEC, dto.id, {
          kind: dto.kind ?? 'available',
          weekday: dto.weekday,
          startTime: dto.startTime,
          endTime: dto.endTime,
          effectiveFrom: dto.effectiveFrom,
          effectiveTo: dto.effectiveTo,
        });
        if (updated) {
          if (actorId != null) {
            const diff = this.audit.diffOf(beforeSnap, updated);
            if (Object.keys(diff).length)
              await this.audit.log({ entity: AVAILABILITY, entityId: updated.id, action: 'update', actorId, changes: diff });
          }
          return updated;
        }
      }
      const created = await this.store.insert<AvailabilityBlock>(AVAILABILITY_SPEC, {
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
        await this.audit.log({ entity: AVAILABILITY, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
  }

  // [v9] soft delete + before 스냅샷 audit(Q3) — 단일 tx
  // [TBO-29C C1] before 재조회·actor/approval 재검증을 잠금 **후**로 이동 — stale audit/타 owner 변경 차단.
  //  owner는 블록 불변(소유자 이전 금지)이라 잠금 키 선정용 사전 조회는 안전하다.
  async remove(id: number, actorId?: number, actorRoles?: string[]): Promise<{ id: number; deleted: boolean }> {
    await this.refresh();
    const current = this.db.findById<AvailabilityBlock>(AVAILABILITY, id);
    if (current) {
      // 잠금 전 fail-fast — 권위 판정은 잠금 후 재실행
      this.assertActorOwner(current.ownerType, current.ownerId, actorId, actorRoles);
      this.assertDeleteApprovalNotRequired(id, actorRoles);
    }
    return this.unitOfWork.run(async () => {
      if (!current) return { id, deleted: false };
      await this.unitOfWork.lockTargets([{ kind: current.ownerType, id: Number(current.ownerId) }]);
      await this.refreshAuthoritative();
      const before = this.db.findById<AvailabilityBlock>(AVAILABILITY, id); // [C1] 잠금 후 재조회
      if (!before) return { id, deleted: false };
      this.assertActorOwner(before.ownerType, before.ownerId, actorId, actorRoles);
      this.assertDeleteApprovalNotRequired(id, actorRoles);
      const deleted = await this.store.remove(AVAILABILITY_SPEC, id, actorId);
      if (deleted && actorId != null)
        await this.audit.log({ entity: AVAILABILITY, entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf({ ...before }) as never });
      return { id, deleted };
    });
  }
}
