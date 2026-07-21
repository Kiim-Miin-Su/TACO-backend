import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { SESSION_REPORTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { AuditService } from '../audit/audit.service';
import { ADMIN_ROLES } from '../auth/roles.decorator';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { Course, COURSES } from '../courses/course.entity';
import { SessionReportRow, SESSION_REPORTS } from './report.entity';
import { CreateReportDto } from './dto/create-report.dto';
import { Student, STUDENTS } from '../students/student.entity';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { studentBelongsToSession } from '../schedule/session-participant.policy';
import { isSessionVisibleToInstructor } from '../schedule/schedule-visibility.policy';

// [보안 2026-07-07 H2] 액터 컨텍스트 — 비관리자(강사)는 본인 세션·본인 보고서만 쓰기 가능(IDOR 차단).
export type ReportActor = { id: number; roles: string[] };
const actorIsAdmin = (actor?: ReportActor) => !!actor && actor.roles.some((r) => (ADMIN_ROLES as string[]).includes(r));

/**
 * 수업 보고서 — 강사 제출 → 관리자 승인/반려.
 * 시수/페이 산정은 '승인된 보고서가 있는 held 세션'만 대상으로 하므로,
 * 여기서 세션 FK·중복(세션×학생)·강사 일치 등 참조 무결성을 먼저 지킨다.
 */
@Injectable()
export class ReportsService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly audit: AuditService, // [감사 전수 2026-07-16] 정산 적격 근거(보고서 상태) 이력
  ) {}

  // 데모 보고서 시드 — 과거 held 세션(schedule 히스토리 20~28)의 일부만 제출(submitted).
  //  → 리포트 현황 대시보드에서 "작성/미작성"이 섞여 보임(전 슬롯 8개 중 3건 작성). 승인(approved) 아님 = 시수/정산 미반영(payouts 불변).
  //  고정 id로 멱등, payouts가 런타임 생성하는 승인 보고서(nextId)와 충돌 없음.
  async onModuleInit(): Promise<void> {
    const hydrated = await this.store.hydrate<SessionReportRow>(SESSION_REPORTS_SPEC);
    if (hydrated.length) return;
    await this.store.seed<SessionReportRow>(SESSION_REPORTS_SPEC, [
      { id: 1, sessionId: 20, studentId: 1, instructorId: 1, content: '주제·요지 파악 향상. 근거 문장 매칭 연습 필요.', status: 'submitted', approvalStatus: 'submitted', submittedAt: new Date().toISOString() },
      { id: 2, sessionId: 21, studentId: 2, instructorId: 2, content: '미분 응용 개념 이해. 연쇄법칙 반복.', status: 'submitted', approvalStatus: 'submitted', submittedAt: new Date().toISOString() },
      { id: 3, sessionId: 26, studentId: 1, instructorId: 1, content: '추론 문제 정답률 상승. 어휘 20개 암기 과제.', status: 'submitted', approvalStatus: 'submitted', submittedAt: new Date().toISOString() },
    ]);
  }

  findAll(): SessionReportRow[] {
    return this.db.findAll<SessionReportRow>(SESSION_REPORTS);
  }

  findAllForActor(actor?: ReportActor): SessionReportRow[] {
    if (!actor || actorIsAdmin(actor)) return this.findAll();
    return this.findAll().filter((report) => {
      const session = this.db.findById<ClassSession>(SESSIONS, report.sessionId);
      return !!session && isSessionVisibleToInstructor(session, actor.id);
    });
  }

  // [B7 E3 2026-07-16] 단건 GET 스코프 갭 수정 — 종전엔 오너 체크가 쓰기(create/update/submit)에만
  //  있어 강사가 타인 보고서 id를 조회할 수 있었다(IDOR). 단건 GET 표준(404→403, B7 문서 §1b) 적용.
  findOne(id: number, actor?: ReportActor): SessionReportRow {
    const row = this.db.findById<SessionReportRow>(SESSION_REPORTS, id);
    if (!row) throw new NotFoundException(`Report ${id} not found`);
    if (actor && !actorIsAdmin(actor)) {
      const session = this.db.findById<ClassSession>(SESSIONS, row.sessionId);
      if (!session || !isSessionVisibleToInstructor(session, actor.id))
        throw new ForbiddenException('담당 일반 수업 강사 또는 관리자만 이 보고서를 조회할 수 있습니다.');
    }
    return row;
  }

  findBySession(sessionId: number): SessionReportRow[] {
    return this.db.findByField<SessionReportRow>(SESSION_REPORTS, 'sessionId', sessionId); // 인덱스 조회
  }

  findBySessionForActor(sessionId: number, actor?: ReportActor): SessionReportRow[] {
    if (actor && !actorIsAdmin(actor)) {
      const session = this.db.findById<ClassSession>(SESSIONS, sessionId);
      if (session && !isSessionVisibleToInstructor(session, actor.id))
        throw new ForbiddenException('담당 일반 수업 강사 또는 관리자만 이 보고서를 조회할 수 있습니다.');
    }
    return this.findBySession(sessionId);
  }

  // 승인된 보고서가 있는 세션 id 집합 — 시수 적격성 판정에 사용(payouts에서 호출).
  approvedSessionIds(): Set<number> {
    return new Set(
      this.db
        .findBy<SessionReportRow>(SESSION_REPORTS, (r) => r.approvalStatus === 'approved')
        .map((r) => r.sessionId),
    );
  }

  async create(dto: CreateReportDto, actor?: ReportActor): Promise<SessionReportRow> {
    // 1) 세션 FK 검증
    const session = this.db.findById<ClassSession>(SESSIONS, dto.sessionId);
    if (!session) throw new BadRequestException(`sessionId ${dto.sessionId} 없음(존재하지 않는 수업)`);
    if (!this.db.findById<Student>(STUDENTS, dto.studentId))
      throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);
    if (!studentBelongsToSession(session, dto.studentId, this.db.findAll<Enrollment>(ENROLLMENTS)))
      throw new BadRequestException(`studentId ${dto.studentId}는 세션 ${dto.sessionId}의 수강생이 아닙니다`);

    // 2) 소유권(H2 IDOR 차단) — 비관리자(강사)는 본인 담당 세션에만 작성 가능.
    if (actor && !actorIsAdmin(actor) && !isSessionVisibleToInstructor(session, actor.id))
      throw new ForbiddenException('담당 일반 수업 강사 또는 관리자만 이 세션의 보고서를 작성할 수 있습니다.');

    // 3) 강사 일치(미지정 시 세션 강사로 채움)
    const instructorId = dto.instructorId ?? session.instructorId;
    if (instructorId !== session.instructorId)
      throw new BadRequestException(
        `보고서 강사(${instructorId})가 세션 강사(${session.instructorId})와 불일치`,
      );

    // 3) (세션, 학생) 중복 보고서 금지 — ERD unique(session_id, student_id)
    const dup = this.db.findBy<SessionReportRow>(
      SESSION_REPORTS,
      (r) => r.sessionId === dto.sessionId && r.studentId === dto.studentId,
    );
    if (dup.length) throw new ConflictException(`세션 ${dto.sessionId}·학생 ${dto.studentId} 보고서가 이미 존재`);

    // 4) 과목 스냅샷(코스 조인) — 코스가 있으면 subjectId 보존
    const course = this.db.findById<Course>(COURSES, session.courseId);
    const status = dto.status ?? 'submitted';
    return this.uow.run(async () => {
      const row = await this.store.insert<SessionReportRow>(SESSION_REPORTS_SPEC, {
        sessionId: dto.sessionId,
        studentId: dto.studentId,
        instructorId,
        subjectId: course?.subjectId,
        content: dto.content,
        homework: dto.homework,
        status,
        approvalStatus: status === 'submitted' ? 'submitted' : 'draft',
        submittedAt: status === 'submitted' ? new Date().toISOString() : undefined,
      });
      // [감사 전수 2026-07-16] 보고서 생성 이력(본문 원문은 기록하지 않음 — 메타만).
      if (actor?.id != null && actor.id > 0) {
        await this.audit.log({
          entity: 'session_reports', entityId: row.id, action: 'create', actorId: actor.id,
          changes: { sessionId: { after: row.sessionId }, approvalStatus: { after: row.approvalStatus } },
        });
      }
      return row;
    });
  }

  // [E0.6 H1] 강사: 본문/숙제 수정(임시 저장·제출 전 정정) — 승인 후 불변(시수 반영).
  //  종전엔 update 경로가 없어 기존 보고서 '임시 저장'이 조용히 유실됐다(UX 감사 H1).
  async updateContent(
    id: number,
    dto: { content?: string; homework?: string },
    actor?: ReportActor,
  ): Promise<SessionReportRow> {
    const r = this.findOne(id, actor);
    // 소유권(H2 IDOR 차단) — 비관리자는 본인 명의 보고서만 수정 가능(submit과 동일 규칙).
    if (actor && !actorIsAdmin(actor) && r.instructorId !== actor.id)
      throw new ForbiddenException('담당 강사 또는 관리자만 이 보고서를 수정할 수 있습니다.');
    if (r.approvalStatus === 'approved') throw new BadRequestException('이미 승인된 보고서는 수정할 수 없습니다.');
    if (dto.content === undefined && dto.homework === undefined)
      throw new BadRequestException('수정할 내용(content/homework)이 필요합니다.');
    return this.uow.run(async () => {
      const after = await this.store.update<SessionReportRow>(SESSION_REPORTS_SPEC, id, {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        // 빈 문자열 = 숙제 비움(명시 null 저장 — undefined는 skip되는 UPDATE 함정 방지).
        //  contracts SessionReport.homework가 optional(string)뿐이라 null 캐스팅 — DB 컬럼은 nullable
        //  (contracts nullable 확장은 다음 계약 버전에서).
        ...(dto.homework !== undefined
          ? { homework: (dto.homework.trim() ? dto.homework : null) as unknown as string }
          : {}),
      }) as SessionReportRow;
      // [감사 전수 2026-07-16] 본문 수정 이력 — 원문 대신 수정 필드명만(내용 프라이버시).
      if (actor?.id != null && actor.id > 0) {
        await this.audit.log({
          entity: 'session_reports', entityId: id, action: 'update', actorId: actor.id,
          changes: { editedFields: { after: Object.keys(dto) } },
        });
      }
      return after;
    });
  }

  // 강사: 작성완료 제출(draft → submitted)
  async submit(id: number, actor?: ReportActor): Promise<SessionReportRow> {
    const r = this.findOne(id, actor);
    // 소유권(H2 IDOR 차단) — 비관리자는 본인 명의 보고서만 제출 가능.
    if (actor && !actorIsAdmin(actor) && r.instructorId !== actor.id)
      throw new ForbiddenException('담당 강사 또는 관리자만 이 보고서를 제출할 수 있습니다.');
    if (r.approvalStatus === 'approved') throw new BadRequestException('이미 승인된 보고서');
    const beforeStatus = r.approvalStatus ?? r.status; // live-reference — update 전에 캡처
    return this.uow.run(async () => {
      const after = await this.store.update<SessionReportRow>(SESSION_REPORTS_SPEC, id, {
        status: 'submitted',
        approvalStatus: 'submitted',
        submittedAt: new Date().toISOString(),
        rejectedReason: undefined,
      }) as SessionReportRow;
      // [감사 전수 2026-07-16] 제출 이력.
      if (actor?.id != null && actor.id > 0) {
        await this.audit.log({
          entity: 'session_reports', entityId: id, action: 'status_change', actorId: actor.id,
          changes: { approvalStatus: { before: beforeStatus, after: 'submitted' } },
        });
      }
      return after;
    });
  }

  // 관리자 승인(submitted → approved) — 승인 시 시수 적격 세션으로 편입
  async approve(id: number, approvedBy?: number): Promise<SessionReportRow> {
    const r = this.findOne(id);
    if (r.approvalStatus !== 'submitted')
      throw new BadRequestException(`승인 불가 상태(${r.approvalStatus ?? r.status}) — submitted만 승인 가능`);
    return this.uow.run(async () => {
      const after = await this.store.update<SessionReportRow>(SESSION_REPORTS_SPEC, id, {
        approvalStatus: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy,
      }) as SessionReportRow;
      // [감사 전수 2026-07-16] 승인 = 시수 적격 편입 근거(0=시스템 시드는 생략).
      if (approvedBy != null && approvedBy > 0) {
        await this.audit.log({
          entity: 'session_reports', entityId: id, action: 'approve', actorId: approvedBy,
          changes: { approvalStatus: { before: 'submitted', after: 'approved' } },
        });
      }
      return after;
    });
  }

  // 관리자 반려(→ rejected, 사유 보존). 재제출 가능.
  async reject(id: number, reason?: string, actorId?: number): Promise<SessionReportRow> {
    const r = this.findOne(id);
    // [B9 E5 2026-07-16] 종전엔 승인 보고서를 무조건 400("정산 회수 후 처리 필요")으로 막았지만
    //  회수 자체가 미구현이라 사실상 영구 잠금이었다. 이제 payout reversal이 있으므로 게이트를
    //  실제 조건으로 정정: **세션이 정산에 연결돼 있을 때만** 차단(회수하면 연결이 풀려 반려 가능).
    if (r.approvalStatus === 'approved') {
      const session = this.db.findById<ClassSession>(SESSIONS, r.sessionId) as (ClassSession & { payoutId?: number | null }) | undefined;
      if (session?.payoutId != null)
        throw new BadRequestException('이미 승인됨 + 정산 연결 — 반려하려면 지급 회수(reverse) 후 처리하세요');
    }
    const beforeStatus = r.approvalStatus ?? r.status; // live-reference — update 전에 캡처
    return this.uow.run(async () => {
      const after = await this.store.update<SessionReportRow>(SESSION_REPORTS_SPEC, id, {
        approvalStatus: 'rejected',
        rejectedReason: reason ?? '사유 미기재',
      }) as SessionReportRow;
      // [감사 전수 2026-07-16] 반려 이력(사유 포함).
      if (actorId != null && actorId > 0) {
        await this.audit.log({
          entity: 'session_reports', entityId: id, action: 'reject', actorId,
          changes: { approvalStatus: { before: beforeStatus, after: 'rejected' } },
          reason: reason ?? '사유 미기재',
        });
      }
      return after;
    });
  }

  async removeBySession(sessionId: number, deletedBy?: number): Promise<number> {
    // [감사 전수 2026-07-16] cascade 삭제도 행별 이력(⚠ 누락 경로였음). 호출부(schedule.remove)가
    //  이미 자체 tx 안이므로 여기서는 removeByField 후 행별 log만 추가(중첩 uow는 passthrough).
    const rows = this.db.findByField<SessionReportRow>(SESSION_REPORTS, 'sessionId', sessionId);
    const count = await this.store.removeByField(SESSION_REPORTS_SPEC, 'sessionId', sessionId, deletedBy);
    if (deletedBy != null && deletedBy > 0) {
      for (const r of rows) {
        await this.audit.log({ entity: 'session_reports', entityId: r.id, action: 'delete', actorId: deletedBy });
      }
    }
    return count;
  }
}
