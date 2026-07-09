// [참조/처리] 강사 수업 요청 → 매니저 승인/반려 (TBO-16 #9, erd.dbml v8 §28).
//  - 요청 생성: ScheduleService.validateSessionInput **재사용**(FK·코호트 — 우회 경로 없음).
//    충돌은 요청 시점 '참고'(pending 세션이 아니므로 점유 없음) — 승인 시점에 createSession이 재검사(확정).
//  - 승인: [상태 갱신 + createSession(충돌 409·force) + createdSessionId 역참조 + audit] 단일 tx 원자화.
//  - 반려: 사유 **필수**(Q2). 승인/반려 모두 audit_log 기록(approve/reject).
//  - 배지: pending 건수는 프론트 lib/tasks.ts 단일 소스에 편입(R1 — 별도 카운트 금지).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AvailabilityKind, AvailabilityOwner, RecurrenceScope, ScheduleRequest, SessionMode, Conflict } from '@kms545487/contracts';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { ScheduleService } from '../schedule/schedule.service';
import { AuditService } from '../audit/audit.service';
import { CreateScheduleRequestDto } from './dto/create-schedule-request.dto';
import { UpdateScheduleRequestDto } from './dto/update-schedule-request.dto';
import { AvailabilityService } from '../availability/availability.service';
import { hasAdminRole } from '../auth/roles.decorator';
import { UpsertAvailabilityDto } from '../availability/dto/upsert-availability.dto';

export const SCHEDULE_REQUESTS = 'schedule_requests';

type ScheduleRequestKindEx = 'session_create' | 'session_update' | 'session_delete' | 'availability_upsert' | 'availability_delete';
type AvailabilityKindEx = AvailabilityKind | 'online_only';
type RequestRow = ScheduleRequest & BaseRow & {
  requestKind?: ScheduleRequestKindEx;
  mode?: SessionMode; // [C2D] 수업방식 보존(contracts 게시 전 로컬 표기 — src에는 반영됨)
  targetSessionId?: number;
  targetAvailabilityId?: number;
  availabilityOwnerType?: AvailabilityOwner;
  availabilityOwnerId?: number;
  availabilityKind?: AvailabilityKindEx;
  availabilityWeekday?: number;
  availabilityStartTime?: string;
  availabilityEndTime?: string;
  availabilityEffectiveFrom?: string;
  availabilityEffectiveTo?: string;
  impactSessionIds?: number[];
  changeSummary?: string;
  requestReason?: string;
  scope?: RecurrenceScope;
};

@Injectable()
export class ScheduleRequestsService {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly schedule: ScheduleService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService,
  ) {}

  /** 요청 생성(pending) — 세션과 동일 검증 + 참고용 충돌 목록 반환. */
  async create(dto: CreateScheduleRequestDto, requesterId: number, requesterRoles?: string[]): Promise<{ row: RequestRow; conflicts: Conflict[] }> {
    if (dto.requestKind === 'availability_upsert' || dto.requestKind === 'availability_delete') {
      return { row: await this.createAvailabilityRequest(dto, requesterId, requesterRoles), conflicts: [] };
    }
    if (dto.requestKind === 'session_update') {
      return this.createSessionUpdateRequest(dto, requesterId, requesterRoles);
    }
    if (dto.requestKind === 'session_delete') {
      return this.createSessionDeleteRequest(dto, requesterId, requesterRoles);
    }
    const instructorId = this.schedule.validateSessionInput({ ...dto, courseId: dto.courseId! }); // FK·코호트(함수 통일)
    // 참고용 충돌 드라이런(승인 시점에 재검사가 확정본)
    const conflicts = this.schedule.checkConflicts({
      sessionDate: dto.sessionDate!, startTime: dto.startTime!, endTime: dto.endTime,
      durationMinutes: dto.durationMinutes, instructorId, roomId: dto.roomId,
      mode: dto.mode, // [C2D] online_only 가용 판정이 요청 mode 기준으로(드라이런도 승인과 동일 조건)
    });
    const row = await this.db.transaction(() => {
      const created = this.db.insert<RequestRow>(SCHEDULE_REQUESTS, {
        requesterId,
        requestKind: 'session_create',
        courseId: dto.courseId!,
        instructorId,
        roomId: dto.roomId,
        sessionDate: dto.sessionDate!,
        startTime: dto.startTime!,
        endTime: dto.endTime,
        durationMinutes: dto.durationMinutes ?? 60,
        kind: dto.kind ?? 'class',
        mode: dto.mode, // [C2D] 보존(미지정=승인 시 SESSION_DEFAULTS.in_person)
        topic: dto.topic,
        studentIds: dto.studentIds,
        requestReason: dto.requestReason,
        status: 'pending',
      } as unknown as Omit<RequestRow, keyof BaseRow>);
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: created.id, action: 'create', actorId: requesterId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
    return { row, conflicts };
  }

  private async createSessionUpdateRequest(dto: CreateScheduleRequestDto, requesterId: number, requesterRoles?: string[]): Promise<{ row: RequestRow; conflicts: Conflict[] }> {
    const target = this.schedule.list({}).find((s) => s.id === dto.targetSessionId);
    if (!target) throw new NotFoundException(`Session ${dto.targetSessionId} not found`);
    if (!hasAdminRole(requesterRoles) && Number(target.instructorId) !== Number(requesterId)) {
      throw new ForbiddenException('강사는 본인 수업 변경만 요청할 수 있습니다.');
    }
    const merged = {
      courseId: dto.courseId ?? target.courseId,
      instructorId: dto.instructorId ?? target.instructorId,
      roomId: dto.roomId ?? target.roomId,
      sessionDate: dto.sessionDate ?? target.sessionDate,
      startTime: dto.startTime ?? target.startTime,
      endTime: dto.endTime ?? target.endTime,
      durationMinutes: dto.durationMinutes ?? target.durationMinutes,
      studentIds: dto.studentIds ?? target.studentIds,
      topic: dto.topic ?? target.topic,
      kind: dto.kind ?? target.kind,
      mode: dto.mode ?? target.mode,
    };
    this.schedule.validateSessionInput(merged);
    const conflicts = this.schedule.checkConflicts({
      sessionDate: merged.sessionDate!, startTime: merged.startTime!, endTime: merged.endTime,
      durationMinutes: merged.durationMinutes, instructorId: merged.instructorId, roomId: merged.roomId,
      ignoreSessionId: target.id, mode: merged.mode,
    });
    const row = await this.db.transaction(() => {
      const created = this.db.insert<RequestRow>(SCHEDULE_REQUESTS, {
        requesterId,
        requestKind: 'session_update',
        targetSessionId: target.id,
        courseId: merged.courseId,
        instructorId: merged.instructorId,
        roomId: merged.roomId,
        sessionDate: merged.sessionDate,
        startTime: merged.startTime,
        endTime: merged.endTime,
        durationMinutes: merged.durationMinutes,
        kind: merged.kind,
        mode: merged.mode,
        topic: merged.topic,
        studentIds: merged.studentIds,
        requestReason: dto.requestReason,
        scope: dto.scope ?? 'this',
        impactSessionIds: [target.id],
        changeSummary: this.sessionUpdateSummary(target, merged),
        status: 'pending',
      } as unknown as Omit<RequestRow, keyof BaseRow>);
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: created.id, action: 'create', actorId: requesterId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
    return { row, conflicts };
  }

  private async createSessionDeleteRequest(dto: CreateScheduleRequestDto, requesterId: number, requesterRoles?: string[]): Promise<{ row: RequestRow; conflicts: Conflict[] }> {
    const target = this.schedule.list({}).find((s) => s.id === dto.targetSessionId);
    if (!target) throw new NotFoundException(`Session ${dto.targetSessionId} not found`);
    if (!hasAdminRole(requesterRoles) && Number(target.instructorId) !== Number(requesterId)) {
      throw new ForbiddenException('강사는 본인 수업 삭제만 요청할 수 있습니다.');
    }
    const row = await this.db.transaction(() => {
      const created = this.db.insert<RequestRow>(SCHEDULE_REQUESTS, {
        requesterId,
        requestKind: 'session_delete',
        targetSessionId: target.id,
        courseId: target.courseId,
        instructorId: target.instructorId,
        roomId: target.roomId,
        sessionDate: target.sessionDate,
        startTime: target.startTime,
        endTime: target.endTime,
        durationMinutes: target.durationMinutes,
        kind: target.kind ?? 'class',
        mode: target.mode,
        topic: target.topic,
        studentIds: target.studentIds,
        requestReason: dto.requestReason,
        impactSessionIds: [target.id],
        changeSummary: `수업 삭제 요청 · ${target.sessionDate} ${target.startTime ?? ''}${target.endTime ? `-${target.endTime}` : ''}`,
        status: 'pending',
      } as unknown as Omit<RequestRow, keyof BaseRow>);
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: created.id, action: 'create', actorId: requesterId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
    return { row, conflicts: [] };
  }

  private sessionUpdateSummary(before: { sessionDate?: string; startTime?: string; endTime?: string; roomId?: number; instructorId?: number }, after: { sessionDate?: string; startTime?: string; endTime?: string; roomId?: number; instructorId?: number }): string {
    const changes: string[] = [];
    if (before.sessionDate !== after.sessionDate) changes.push(`${before.sessionDate} -> ${after.sessionDate}`);
    if (before.startTime !== after.startTime || before.endTime !== after.endTime) changes.push(`${before.startTime ?? ''}-${before.endTime ?? ''} -> ${after.startTime ?? ''}-${after.endTime ?? ''}`);
    if (before.instructorId !== after.instructorId) changes.push(`강사 ${before.instructorId} -> ${after.instructorId}`);
    if (before.roomId !== after.roomId) changes.push(`강의실 ${before.roomId ?? '-'} -> ${after.roomId ?? '-'}`);
    return changes.length ? `수업 변경 요청 · ${changes.join(' · ')}` : '수업 변경 요청';
  }

  private async createAvailabilityRequest(dto: CreateScheduleRequestDto, requesterId: number, requesterRoles?: string[]): Promise<RequestRow> {
    const upsert = dto.requestKind === 'availability_upsert' ? this.toAvailabilityUpsert(dto) : null;
    const target = dto.targetAvailabilityId != null ? this.availability.findOne(dto.targetAvailabilityId) : undefined;
    if (dto.targetAvailabilityId != null && !target) {
      throw new BadRequestException(`availability ${dto.targetAvailabilityId} not found`);
    }
    if (upsert) this.availability.validateRequestableUpsert(upsert, requesterId, requesterRoles);
    if (!hasAdminRole(requesterRoles)) {
      const ownerType = upsert?.ownerType ?? target?.ownerType;
      const ownerId = upsert?.ownerId ?? target?.ownerId;
      if (ownerType !== 'instructor' || Number(ownerId) !== requesterId) {
        throw new ForbiddenException('강사는 본인 강사 가용/불가 변경만 요청할 수 있습니다.');
      }
      if (target && (target.ownerType !== ownerType || Number(target.ownerId) !== Number(ownerId))) {
        throw new ForbiddenException('강사는 본인 강사 가용/불가 변경만 요청할 수 있습니다.');
      }
    }
    const impact = dto.requestKind === 'availability_upsert'
      ? this.availability.previewUpsertImpact(upsert!)
      : this.availability.previewDeleteImpact(dto.targetAvailabilityId!);
    const requestedBlock = upsert ?? target;
    const row = await this.db.transaction(() => {
      const created = this.db.insert<RequestRow>(SCHEDULE_REQUESTS, {
        requestKind: dto.requestKind,
        requesterId,
        targetAvailabilityId: dto.targetAvailabilityId,
        availabilityOwnerType: requestedBlock?.ownerType,
        availabilityOwnerId: requestedBlock?.ownerId,
        availabilityKind: requestedBlock?.kind,
        availabilityWeekday: requestedBlock?.weekday,
        availabilityStartTime: requestedBlock?.startTime,
        availabilityEndTime: requestedBlock?.endTime,
        availabilityEffectiveFrom: requestedBlock?.effectiveFrom,
        availabilityEffectiveTo: requestedBlock?.effectiveTo,
        impactSessionIds: impact.map((x) => x.sessionId),
        changeSummary: this.availabilitySummary(dto.requestKind!, upsert, impact.length),
        requestReason: dto.requestReason,
        status: 'pending',
      } as Omit<RequestRow, keyof BaseRow>);
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: created.id, action: 'create', actorId: requesterId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
    return row;
  }

  private availabilitySummary(kind: ScheduleRequestKindEx, dto: UpsertAvailabilityDto | null, count: number): string {
    if (kind === 'availability_delete') return `가용/불가 블록 삭제 요청 · 영향 수업 ${count}건`;
    return `${dto?.ownerType ?? 'unknown'}#${dto?.ownerId ?? '-'} ${dto?.kind ?? 'available'} ${dto?.weekday ?? '-'} ${dto?.startTime ?? '-'}–${dto?.endTime ?? '-'} · 영향 수업 ${count}건`;
  }

  private toAvailabilityUpsert(dto: CreateScheduleRequestDto): UpsertAvailabilityDto {
    return {
      id: dto.targetAvailabilityId,
      ownerType: dto.availabilityOwnerType!,
      ownerId: dto.availabilityOwnerId!,
      kind: dto.availabilityKind ?? 'available',
      weekday: dto.availabilityWeekday!,
      startTime: dto.availabilityStartTime!,
      endTime: dto.availabilityEndTime!,
      effectiveFrom: dto.availabilityEffectiveFrom,
      effectiveTo: dto.availabilityEffectiveTo,
    };
  }

  /** 목록 — 관리자=전체(status 필터), 강사=본인 요청만(컨트롤러에서 requesterId 강제). */
  list(q: { status?: ScheduleRequest['status']; requesterId?: number }): RequestRow[] {
    let rows = q.status
      ? this.db.findByField<RequestRow>(SCHEDULE_REQUESTS, 'status', q.status)
      : this.db.findAll<RequestRow>(SCHEDULE_REQUESTS);
    if (q.requesterId != null) rows = rows.filter((r) => r.requesterId === q.requesterId);
    return rows.sort((a, b) => b.id - a.id);
  }

  /** 승인 — [요청 상태 + 세션 생성(충돌 409·force 재검사) + 역참조 + audit] 단일 tx 원자화. */
  async approve(id: number, decidedBy: number, force?: boolean): Promise<{ request: RequestRow; conflicts: Conflict[] }> {
    const req = this.mustPending(id);
    if (req.requestKind === 'availability_upsert' || req.requestKind === 'availability_delete') {
      return this.approveAvailability(req, decidedBy);
    }
    if (req.requestKind === 'session_update') {
      return this.approveSessionUpdate(req, decidedBy, force);
    }
    if (req.requestKind === 'session_delete') {
      return this.approveSessionDelete(req, decidedBy);
    }
    return this.db.transaction(async () => {
      const before = { ...req };
      // 기존 createSession 경로 그대로 — FK·코호트 재검증 + 충돌 409(force면 강제) + create audit(actor=승인자)
      const { row: session, conflicts } = await this.schedule.create({
        courseId: req.courseId!, instructorId: req.instructorId, roomId: req.roomId,
        sessionDate: req.sessionDate!, startTime: req.startTime!, endTime: req.endTime,
        durationMinutes: req.durationMinutes, topic: req.topic,
        studentIds: req.studentIds, kind: req.kind, mode: req.mode, force, // [C2D] mode 보존

      }, decidedBy);
      const updated = this.db.update<RequestRow>(SCHEDULE_REQUESTS, id, {
        status: 'approved', decidedBy, decidedAt: new Date().toISOString(), createdSessionId: session.id,
      })!;
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: id, action: 'approve', actorId: decidedBy, changes: this.audit.diffOf(before, updated) as never });
      return { request: updated, conflicts };
    });
  }

  private async approveSessionUpdate(req: RequestRow, decidedBy: number, force?: boolean): Promise<{ request: RequestRow; conflicts: Conflict[] }> {
    if (req.targetSessionId == null) throw new BadRequestException('변경할 세션 id가 없습니다.');
    return this.db.transaction(async () => {
      const before = { ...req };
      const { conflicts } = await this.schedule.update(req.targetSessionId!, {
        courseId: req.courseId, instructorId: req.instructorId, roomId: req.roomId,
        sessionDate: req.sessionDate, startTime: req.startTime, endTime: req.endTime,
        durationMinutes: req.durationMinutes, topic: req.topic, studentIds: req.studentIds,
        kind: req.kind, mode: req.mode, scope: req.scope, force,
      }, decidedBy);
      const updated = this.db.update<RequestRow>(SCHEDULE_REQUESTS, req.id, {
        status: 'approved', decidedBy, decidedAt: new Date().toISOString(),
      })!;
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: req.id, action: 'approve', actorId: decidedBy, changes: this.audit.diffOf(before, updated) as never });
      return { request: updated, conflicts };
    });
  }

  private async approveSessionDelete(req: RequestRow, decidedBy: number): Promise<{ request: RequestRow; conflicts: Conflict[] }> {
    if (req.targetSessionId == null) throw new BadRequestException('삭제할 세션 id가 없습니다.');
    return this.db.transaction(async () => {
      const before = { ...req };
      await this.schedule.remove(req.targetSessionId!, decidedBy);
      const updated = this.db.update<RequestRow>(SCHEDULE_REQUESTS, req.id, {
        status: 'approved', decidedBy, decidedAt: new Date().toISOString(),
      })!;
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: req.id, action: 'approve', actorId: decidedBy, changes: this.audit.diffOf(before, updated) as never });
      return { request: updated, conflicts: [] };
    });
  }

  private async approveAvailability(req: RequestRow, decidedBy: number): Promise<{ request: RequestRow; conflicts: Conflict[] }> {
    return this.db.transaction(async () => {
      const before = { ...req };
      if (req.requestKind === 'availability_upsert') {
        await this.availability.upsert({
          id: req.targetAvailabilityId,
          ownerType: req.availabilityOwnerType!,
          ownerId: req.availabilityOwnerId!,
          kind: (req.availabilityKind ?? 'available') as AvailabilityKindEx,
          weekday: req.availabilityWeekday!,
          startTime: req.availabilityStartTime!,
          endTime: req.availabilityEndTime!,
          effectiveFrom: req.availabilityEffectiveFrom,
          effectiveTo: req.availabilityEffectiveTo,
        }, decidedBy, ['admin']);
      } else if (req.targetAvailabilityId != null) {
        await this.availability.remove(req.targetAvailabilityId, decidedBy, ['admin']);
      } else {
        throw new BadRequestException('삭제할 availability id가 없습니다.');
      }
      const updated = this.db.update<RequestRow>(SCHEDULE_REQUESTS, req.id, {
        status: 'approved', decidedBy, decidedAt: new Date().toISOString(),
      })!;
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: req.id, action: 'approve', actorId: decidedBy, changes: this.audit.diffOf(before, updated) as never });
      return { request: updated, conflicts: [] };
    });
  }

  /** [C2C-b 청크2] pending 요청 수정(관리자) — 생성 경로와 동일 검증 재사용 + audit update diff.
   *  불변: requestKind·targetAvailabilityId·availability owner(DTO에 없음 → forbidNonWhitelisted 400).
   *  availability_delete는 수정 항목이 없어 400(반려 후 재요청). availability_upsert는 impact/요약 재계산. */
  async update(id: number, dto: UpdateScheduleRequestDto, actorId: number): Promise<RequestRow> {
    const req = this.mustPending(id);
    if (req.requestKind === 'availability_delete' || req.requestKind === 'session_delete') {
      throw new BadRequestException('삭제 요청은 수정할 항목이 없습니다 — 반려 후 재요청하세요.');
    }
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(dto)) if (v !== undefined) patch[k] = v;
    if (!Object.keys(patch).length) throw new BadRequestException('수정할 필드가 없습니다');
    const merged = { ...req, ...patch } as RequestRow;
    if (!req.requestKind || req.requestKind === 'session_create' || req.requestKind === 'session_update') {
      // FK·코호트 재검증 + 코스 변경 시 기본 강사 재해석(생성 경로와 동일 규칙)
      patch.instructorId = this.schedule.validateSessionInput({ ...merged, courseId: merged.courseId! });
    } else {
      // availability_upsert — owner/target 불변(원요청자 소유 유지), 겹침·FK·기간 재검증 후 impact 재계산
      const upsert = this.toAvailabilityUpsert(merged as unknown as CreateScheduleRequestDto);
      this.availability.validateRequestableUpsert(upsert, req.requesterId, ['admin']);
      const impact = this.availability.previewUpsertImpact(upsert);
      patch.impactSessionIds = impact.map((x) => x.sessionId);
      patch.changeSummary = this.availabilitySummary('availability_upsert', upsert, impact.length);
    }
    return this.db.transaction(() => {
      const before = { ...req };
      const updated = this.db.update<RequestRow>(SCHEDULE_REQUESTS, id, patch as Partial<RequestRow>)!;
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: id, action: 'update', actorId, changes: this.audit.diffOf(before, updated) as never });
      return updated;
    });
  }

  /** 반려 — 사유 필수(DTO 강제). */
  async reject(id: number, decidedBy: number, reason: string): Promise<RequestRow> {
    this.mustPending(id);
    return this.db.transaction(() => {
      const updated = this.db.update<RequestRow>(SCHEDULE_REQUESTS, id, {
        status: 'rejected', reason, decidedBy, decidedAt: new Date().toISOString(),
      })!;
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: id, action: 'reject', actorId: decidedBy, reason });
      return updated;
    });
  }

  /** 본인 pending 요청 철회(soft delete) — 강사용. 타인 요청은 403. */
  async withdraw(id: number, requesterId: number): Promise<{ id: number; deleted: boolean }> {
    const req = this.mustPending(id);
    if (req.requesterId !== requesterId) throw new ForbiddenException('본인 요청만 철회할 수 있습니다');
    return this.db.transaction(() => {
      const deleted = this.db.remove(SCHEDULE_REQUESTS, id, requesterId);
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: id, action: 'delete', actorId: requesterId, changes: this.audit.snapshotOf({ ...req }) as never });
      return { id, deleted };
    });
  }

  private mustPending(id: number): RequestRow {
    const req = this.db.findById<RequestRow>(SCHEDULE_REQUESTS, id);
    if (!req) throw new NotFoundException(`Request ${id} not found`);
    if (req.status !== 'pending') throw new BadRequestException(`이미 처리된 요청입니다(${req.status})`);
    return req;
  }
}
