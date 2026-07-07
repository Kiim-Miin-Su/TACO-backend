// [참조/처리] 강사 수업 요청 → 매니저 승인/반려 (TBO-16 #9, erd.dbml v8 §28).
//  - 요청 생성: ScheduleService.validateSessionInput **재사용**(FK·코호트 — 우회 경로 없음).
//    충돌은 요청 시점 '참고'(pending 세션이 아니므로 점유 없음) — 승인 시점에 createSession이 재검사(확정).
//  - 승인: [상태 갱신 + createSession(충돌 409·force) + createdSessionId 역참조 + audit] 단일 tx 원자화.
//  - 반려: 사유 **필수**(Q2). 승인/반려 모두 audit_log 기록(approve/reject).
//  - 배지: pending 건수는 프론트 lib/tasks.ts 단일 소스에 편입(R1 — 별도 카운트 금지).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ScheduleRequest, Conflict } from '@kms545487/contracts';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { ScheduleService } from '../schedule/schedule.service';
import { AuditService } from '../audit/audit.service';
import { CreateScheduleRequestDto } from './dto/create-schedule-request.dto';

export const SCHEDULE_REQUESTS = 'schedule_requests';

type RequestRow = ScheduleRequest & BaseRow;

@Injectable()
export class ScheduleRequestsService {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly schedule: ScheduleService,
    private readonly audit: AuditService,
  ) {}

  /** 요청 생성(pending) — 세션과 동일 검증 + 참고용 충돌 목록 반환. */
  async create(dto: CreateScheduleRequestDto, requesterId: number): Promise<{ row: RequestRow; conflicts: Conflict[] }> {
    const instructorId = this.schedule.validateSessionInput(dto); // FK·코호트(함수 통일)
    // 참고용 충돌 드라이런(승인 시점에 재검사가 확정본)
    const conflicts = this.schedule.checkConflicts({
      sessionDate: dto.sessionDate, startTime: dto.startTime, endTime: dto.endTime,
      durationMinutes: dto.durationMinutes, instructorId, roomId: dto.roomId,
    });
    const row = await this.db.transaction(() => {
      const created = this.db.insert<RequestRow>(SCHEDULE_REQUESTS, {
        requesterId,
        courseId: dto.courseId,
        instructorId,
        roomId: dto.roomId,
        sessionDate: dto.sessionDate,
        startTime: dto.startTime,
        endTime: dto.endTime,
        durationMinutes: dto.durationMinutes ?? 60,
        kind: dto.kind ?? 'class',
        topic: dto.topic,
        studentIds: dto.studentIds,
        status: 'pending',
      } as Omit<RequestRow, keyof BaseRow>);
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: created.id, action: 'create', actorId: requesterId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
    return { row, conflicts };
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
    return this.db.transaction(async () => {
      // 기존 createSession 경로 그대로 — FK·코호트 재검증 + 충돌 409(force면 강제) + create audit(actor=승인자)
      const { row: session, conflicts } = await this.schedule.create({
        courseId: req.courseId, instructorId: req.instructorId, roomId: req.roomId,
        sessionDate: req.sessionDate, startTime: req.startTime, endTime: req.endTime,
        durationMinutes: req.durationMinutes, topic: req.topic,
        studentIds: req.studentIds, kind: req.kind, force,
      }, decidedBy);
      const updated = this.db.update<RequestRow>(SCHEDULE_REQUESTS, id, {
        status: 'approved', decidedBy, decidedAt: new Date().toISOString(), createdSessionId: session.id,
      })!;
      this.audit.log({ entity: SCHEDULE_REQUESTS, entityId: id, action: 'approve', actorId: decidedBy });
      return { request: updated, conflicts };
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
