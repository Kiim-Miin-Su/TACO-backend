import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase } from '../../database/in-memory.database';
import {
  ATTENDANCE_SPEC,
  COURSES_SPEC,
  ENROLLMENTS_SPEC,
  SESSION_REPORTS_SPEC,
  STUDENTS_SPEC,
  STUDENT_ACADEMIC_HISTORIES_SPEC,
  SUBJECTS_SPEC,
  USERS_SPEC,
} from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import {
  CalendarUnitOfWork,
  sessionAccountingLockKeys,
} from '../../database/calendar-unit-of-work.service';
import { ClassSessionsStore } from '../schedule/class-sessions.store';
import { AuditService } from '../audit/audit.service';
import { ADMIN_ROLES } from '../auth/roles.decorator';
import { ClassSession, SESSIONS } from '../schedule/schedule.entity';
import { Course } from '../courses/course.entity';
import { SessionReportRow, SessionReportViewRow, SESSION_REPORTS } from './report.entity';
import { CreateReportDto } from './dto/create-report.dto';
import { Student } from '../students/student.entity';
import { StudentAcademicHistory } from '../students/student-academic-history.entity';
import { currentAcademicHistory } from '../students/student-academic-projection';
import { Enrollment, ENROLLMENTS } from '../enrollments/enrollment.entity';
import { buildCohortIndex, participantIdsForSession, studentBelongsToSession } from '../schedule/session-participant.policy';
import { isSessionVisibleToInstructor } from '../schedule/schedule-visibility.policy';
import { Subject } from '../subjects/subject.entity';
import { StaffAccount } from '../users/user.entity';
import type { Attendance } from '../attendance/attendance.entity';
import { attendanceCompletionHoldPatch } from '../schedule/session-temporal-transition.policy';
import { isPayoutLocked } from '../schedule/session-accounting.policy';

// [보안 2026-07-07 H2] 액터 컨텍스트 — 비관리자(강사)는 본인 세션·본인 보고서만 쓰기 가능(IDOR 차단).
export type ReportActor = { id: number; roles: string[] };
const actorIsAdmin = (actor?: ReportActor) => !!actor && actor.roles.some((r) => (ADMIN_ROLES as string[]).includes(r));

/**
 * 수업 보고서 — 강사 제출 → 관리자 승인/반려.
 * 시수/페이 산정은 '대상 학생 전원의 보고서가 승인된 held 세션'만 대상으로 하므로,
 * 여기서 세션 FK·중복(세션×학생)·강사 일치 등 참조 무결성을 먼저 지킨다.
 *
 * [TBO-53 C1 2026-07-23] 상태 전이의 DB 권위 완결 — TBO-50 P0-3 이행.
 *  submit/updateContent/approve/reject 전부: report advisory lock → **DB 재조회** → 가드 →
 *  `approval_status` CAS(updateIf) — approve-vs-reject/approve-vs-update 경쟁에서 정확히
 *  1승자(패자 409)·모순 audit 0. reject의 정산 연결 판정(session.payoutId)도 session lock+DB 재조회.
 */
@Injectable()
export class ReportsService implements OnModuleInit {
  // [TBO-54 C2 대표 지시 콘솔 로깅] 전이 관측 — allowlist(action·id·actor·상태 전이·결과)만, 본문·PII 0.
  private readonly transitionLog = new Logger('report-transition');

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
    private readonly uow: CalendarUnitOfWork,
    private readonly sessionsStore: ClassSessionsStore, // [TBO-53 C1] reject의 payoutId DB 재조회
    private readonly audit: AuditService, // [감사 전수 2026-07-16] 정산 적격 근거(보고서 상태) 이력
  ) {}

  /** [TBO-53 C1] lock 뒤 판정용 DB 재조회 — PG 미가용(메모리 모드)일 땐 메모리 행이 그대로 권위. */
  private async reportFromDb(id: number): Promise<SessionReportRow> {
    const [row] = await this.store.findActive<SessionReportRow>(SESSION_REPORTS_SPEC, {
      where: { id } as Partial<SessionReportRow>, limit: 1,
    });
    if (!row) throw new NotFoundException(`Report ${id} not found`);
    return row;
  }

  /**
   * 보고서 읽기 모델의 단일 조인 경계.
   * 작성값(content/progressPage/homework)만 report 행이 소유하고, 화면 헤더는 현재 원부와
   * 세션/코스/과목/강사를 배치 조회해 투영한다. 학년은 수업일 당시 유효한 학사 이력을 사용한다.
   */
  private async projectViews(
    rows: readonly SessionReportRow[],
    prefetchedSessions?: readonly ClassSession[],
  ): Promise<SessionReportViewRow[]> {
    if (!rows.length) return [];
    const sessions = prefetchedSessions ?? await this.sessionsStore.findByIdsDb(rows.map((row) => row.sessionId));
    const sessionById = new Map(sessions.map((row) => [row.id, row]));
    const studentIds = rows.map((row) => row.studentId);
    const courseIds = sessions.map((row) => row.courseId);
    const instructorIds = rows.map((row) => row.instructorId);
    const [students, histories, courses, instructors] = await Promise.all([
      this.store.findActiveByFieldValues<Student>(STUDENTS_SPEC, 'id', studentIds),
      this.store.findActiveByFieldValues<StudentAcademicHistory>(
        STUDENT_ACADEMIC_HISTORIES_SPEC,
        'studentId',
        studentIds,
      ),
      this.store.findActiveByFieldValues<Course>(COURSES_SPEC, 'id', courseIds),
      this.store.findActiveByFieldValues<StaffAccount>(USERS_SPEC, 'id', instructorIds),
    ]);
    const subjectIds = courses.map((row) => row.subjectId);
    const subjects = await this.store.findActiveByFieldValues<Subject>(SUBJECTS_SPEC, 'id', subjectIds);
    const studentById = new Map(students.map((row) => [row.id, row]));
    const courseById = new Map(courses.map((row) => [row.id, row]));
    const subjectById = new Map(subjects.map((row) => [row.id, row]));
    const instructorById = new Map(instructors.map((row) => [row.id, row]));
    const historiesByStudent = new Map<number, StudentAcademicHistory[]>();
    for (const history of histories) {
      const values = historiesByStudent.get(history.studentId) ?? [];
      values.push(history);
      historiesByStudent.set(history.studentId, values);
    }

    return rows.map((report) => {
      const session = sessionById.get(report.sessionId);
      const student = studentById.get(report.studentId);
      const course = session ? courseById.get(session.courseId) : undefined;
      const instructor = instructorById.get(report.instructorId);
      if (!session || !student || !course || !instructor) {
        throw new NotFoundException(
          `Report ${report.id} context is incomplete (session/student/course/instructor)`,
        );
      }
      const subject = subjectById.get(course.subjectId);
      const academic = currentAcademicHistory(
        historiesByStudent.get(student.id) ?? [],
        session.sessionDate,
      );
      return {
        ...report,
        context: {
          student: {
            id: student.id,
            name: student.name,
            grade: academic?.grade,
            schoolName: academic?.schoolName,
          },
          session: {
            id: session.id,
            sessionDate: session.sessionDate,
            startTime: session.startTime,
            endTime: session.endTime,
            durationMinutes: session.durationMinutes,
          },
          course: {
            id: course.id,
            name: course.name,
          },
          subject: subject ? { id: subject.id, name: subject.name } : undefined,
          instructor: {
            id: instructor.id,
            name: instructor.name,
          },
        },
      };
    });
  }

  // 데모 보고서 시드 — 과거 held 세션(schedule 히스토리 20~28)의 일부만 제출(submitted).
  //  → 리포트 현황 대시보드에서 "작성/미작성"이 섞여 보임(전 슬롯 8개 중 3건 작성). 승인(approved) 아님 = 시수/정산 미반영(payouts 불변).
  //  고정 id로 멱등, payouts가 런타임 생성하는 승인 보고서(nextId)와 충돌 없음.
  async onModuleInit(): Promise<void> {
    await this.store.hydrate<SessionReportRow>(SESSION_REPORTS_SPEC);
  }

  findAll(): SessionReportRow[] {
    return this.db.findAll<SessionReportRow>(SESSION_REPORTS);
  }

  /** [TBO-54 C2] 목록 READ = DB 권위(행 원부). 강사 가시성 필터는 세션 읽기모델
   *  (EP2 TTL hydrate — staleness 유계) 기반 — 세션 전환은 후속 청크. */
  async listDbForActor(actor?: ReportActor, sessionId?: number): Promise<SessionReportViewRow[]> {
    if (sessionId != null && actor && !actorIsAdmin(actor)) {
      const target = await this.sessionsStore.findByIdDb(sessionId);
      if (target && !isSessionVisibleToInstructor(target, actor.id))
        throw new ForbiddenException('담당 일반 수업 강사 또는 관리자만 이 보고서를 조회할 수 있습니다.');
    }
    const rows = await this.store.findActive<SessionReportRow>(SESSION_REPORTS_SPEC, {
      where: sessionId == null ? undefined : ({ sessionId } as Partial<SessionReportRow>),
      orderBy: { field: 'id' },
    });
    const sessions = await this.sessionsStore.findByIdsDb(rows.map((row) => row.sessionId));
    if (!actor || actorIsAdmin(actor)) return this.projectViews(rows, sessions);
    const sessionById = new Map(sessions.map((row) => [row.id, row]));
    const visible = rows.filter((report) => {
      const session = sessionById.get(report.sessionId);
      return !!session && isSessionVisibleToInstructor(session, actor.id);
    });
    return this.projectViews(visible, sessions);
  }

  /** [TBO-54 C2] 단건 READ = DB 권위 + 기존 스코프 규칙(404→403 표준) 유지. */
  async getDbForActor(id: number, actor?: ReportActor): Promise<SessionReportViewRow> {
    const row = await this.reportFromDb(id);
    const session = await this.sessionsStore.findByIdDb(row.sessionId);
    if (actor && !actorIsAdmin(actor)) {
      if (!session || !isSessionVisibleToInstructor(session, actor.id))
        throw new ForbiddenException('담당 일반 수업 강사 또는 관리자만 이 보고서를 조회할 수 있습니다.');
    }
    return (await this.projectViews([row], session ? [session] : []))[0];
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

  /** 회계 영향 미리보기용 보고서 완전성. payout 적격성 자체는 PayoutReadinessPolicy가 최종 권위다. */
  isSessionReportComplete(sessionId: number): boolean {
    const session = this.db.findById<ClassSession>(SESSIONS, sessionId);
    if (!session) return false;
    const participantIds = participantIdsForSession(
      session,
      buildCohortIndex(this.db.findAll<Enrollment>(ENROLLMENTS)),
    );
    if (participantIds.length === 0) return false;
    const approved = new Set(
      this.findBySession(sessionId)
        .filter((row) => row.approvalStatus === 'approved')
        .map((row) => row.studentId),
    );
    return participantIds.every((studentId) => approved.has(studentId));
  }

  async create(dto: CreateReportDto, actor?: ReportActor): Promise<SessionReportRow> {
    // [TBO-56 C2b] 판정 전부 DB 기준 + report lock 안에서(TBO-53이 전이 4종만 전환했던 갭 해소).
    return this.uow.run(async () => {
      await this.uow.lockTargets(sessionAccountingLockKeys({ sessionIds: [dto.sessionId] }));
      // 1) 세션 FK 검증 — DB 재조회
      const session = await this.sessionsStore.findByIdDb(dto.sessionId);
      if (!session) throw new BadRequestException(`sessionId ${dto.sessionId} 없음(존재하지 않는 수업)`);
      const [student] = await this.store.findActive<Student>(STUDENTS_SPEC, { where: { id: dto.studentId } as Partial<Student>, limit: 1 });
      if (!student) throw new BadRequestException(`studentId ${dto.studentId} 없음(존재하지 않는 학생)`);
      if (!studentBelongsToSession(session, dto.studentId, await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC)))
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

      // 4) (세션, 학생) 중복 보고서 금지 — DB 판별(물리 unique가 최후 방어)
      const dup = await this.store.findActive<SessionReportRow>(SESSION_REPORTS_SPEC, {
        where: { sessionId: dto.sessionId, studentId: dto.studentId } as Partial<SessionReportRow>, limit: 1,
      });
      if (dup.length) throw new ConflictException(`세션 ${dto.sessionId}·학생 ${dto.studentId} 보고서가 이미 존재`);

      // 5) 과목 스냅샷(코스 조인) — 코스가 있으면 subjectId 보존
      const [course] = await this.store.findActive<Course>(COURSES_SPEC, { where: { id: session.courseId } as Partial<Course>, limit: 1 });
      const status = dto.status ?? 'submitted';
      const row = await this.store.insert<SessionReportRow>(SESSION_REPORTS_SPEC, {
        sessionId: dto.sessionId,
        studentId: dto.studentId,
        instructorId,
        subjectId: course?.subjectId,
        content: dto.content,
        progressPage: dto.progressPage,
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
    dto: { content?: string; progressPage?: string; homework?: string },
    actor?: ReportActor,
  ): Promise<SessionReportRow> {
    this.findOne(id, actor); // 조회 스코프(IDOR 404/403) 선판정 — READ 전환은 C2
    if (dto.content === undefined && dto.progressPage === undefined && dto.homework === undefined)
      throw new BadRequestException('수정할 내용(content/progressPage/homework)이 필요합니다.');
    return this.uow.run(async () => {
      const scoped = await this.reportFromDb(id);
      await this.uow.lockTargets(sessionAccountingLockKeys({
        sessionIds: [scoped.sessionId],
        reportIds: [id],
      }));
      const r = await this.reportFromDb(id); // [C1] lock 뒤 DB 재조회 — 낡은 메모리 판정 금지
      // 소유권(H2 IDOR 차단) — 비관리자는 본인 명의 보고서만 수정 가능(submit과 동일 규칙).
      if (actor && !actorIsAdmin(actor) && r.instructorId !== actor.id)
        throw new ForbiddenException('담당 강사 또는 관리자만 이 보고서를 수정할 수 있습니다.');
      if (r.approvalStatus === 'approved') throw new BadRequestException('이미 승인된 보고서는 수정할 수 없습니다.');
      // [C1] approval_status CAS — 수정과 승인이 겹치면 한쪽만 성공(승인된 본문 무단 변경 차단).
      const after = await this.store.updateIf<SessionReportRow>(SESSION_REPORTS_SPEC, id, { approvalStatus: r.approvalStatus }, {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.progressPage !== undefined
          ? { progressPage: (dto.progressPage.trim() ? dto.progressPage : null) as unknown as string }
          : {}),
        // 빈 문자열 = 숙제 비움(명시 null 저장 — undefined는 skip되는 UPDATE 함정 방지).
        //  contracts SessionReport.homework가 optional(string)뿐이라 null 캐스팅 — DB 컬럼은 nullable
        //  (contracts nullable 확장은 다음 계약 버전에서).
        ...(dto.homework !== undefined
          ? { homework: (dto.homework.trim() ? dto.homework : null) as unknown as string }
          : {}),
      });
      if (!after) throw new ConflictException('보고서 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
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

  async removeDraft(id: number, actor?: ReportActor): Promise<{ id: number; deleted: true }> {
    const scoped = await this.reportFromDb(id);
    return this.uow.run(async () => {
      await this.uow.lockTargets(sessionAccountingLockKeys({
        sessionIds: [scoped.sessionId],
        reportIds: [id],
      }));
      const report = await this.reportFromDb(id);
      if (actor && !actorIsAdmin(actor) && report.instructorId !== actor.id) {
        throw new ForbiddenException('작성 강사 또는 관리자만 이 draft 보고서를 철회할 수 있습니다.');
      }
      if (report.approvalStatus !== 'draft' || report.status !== 'draft') {
        throw new BadRequestException('draft 상태의 보고서만 철회할 수 있습니다.');
      }
      const session = await this.sessionsStore.findByIdDb(report.sessionId);
      if (!session) throw new ConflictException('연결된 수업을 찾을 수 없어 보고서를 철회할 수 없습니다.');
      if (isPayoutLocked(session)) {
        throw new BadRequestException('정산에 연결되거나 지급 완료된 수업의 보고서는 정산 회수 후 철회할 수 있습니다.');
      }
      const deleted = await this.store.remove(SESSION_REPORTS_SPEC, id, actor?.id);
      if (!deleted) throw new ConflictException('이미 철회되거나 상태가 변경된 보고서입니다.');
      if (actor?.id != null && actor.id > 0) {
        await this.audit.log({
          entity: SESSION_REPORTS,
          entityId: id,
          action: 'delete',
          actorId: actor.id,
          changes: {
            sessionId: { before: report.sessionId },
            studentId: { before: report.studentId },
            approvalStatus: { before: 'draft' },
          },
          reason: 'draft 보고서 작성 철회',
        });
      }
      return { id, deleted: true };
    });
  }

  // 강사: 작성완료 제출(draft → submitted)
  async submit(id: number, actor?: ReportActor): Promise<SessionReportRow> {
    this.findOne(id, actor); // 조회 스코프(IDOR 404/403) 선판정 — READ 전환은 C2
    return this.uow.run(async () => {
      const scoped = await this.reportFromDb(id);
      await this.uow.lockTargets(sessionAccountingLockKeys({
        sessionIds: [scoped.sessionId],
        reportIds: [id],
      }));
      const r = await this.reportFromDb(id); // [C1] lock 뒤 DB 재조회
      // 소유권(H2 IDOR 차단) — 비관리자는 본인 명의 보고서만 제출 가능.
      if (actor && !actorIsAdmin(actor) && r.instructorId !== actor.id)
        throw new ForbiddenException('담당 강사 또는 관리자만 이 보고서를 제출할 수 있습니다.');
      if (r.approvalStatus === 'approved') throw new BadRequestException('이미 승인된 보고서');
      const beforeStatus = r.approvalStatus ?? r.status;
      // [C1] approval_status CAS — 다른 인스턴스의 승인과 겹치면 409(승인 뒤 재제출 덮어쓰기 차단).
      const after = await this.store.updateIf<SessionReportRow>(SESSION_REPORTS_SPEC, id, { approvalStatus: r.approvalStatus }, {
        status: 'submitted',
        approvalStatus: 'submitted',
        submittedAt: new Date().toISOString(),
        rejectedReason: undefined,
      });
      if (!after) throw new ConflictException('보고서 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
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
  //  [C1] 존재 판정도 DB(reportFromDb 404) — 다른 인스턴스가 만든 보고서도 즉시 승인 가능(메모리 404 제거).
  async approve(id: number, approvedBy?: number): Promise<SessionReportRow> {
    return this.uow.run(async () => {
      // report.sessionId는 불변 FK라 잠금 대상 산정에만 선조회한다. 실제 승인 판정은 두 자산을
      // 함께 잠근 뒤 fresh DB 행으로 다시 수행한다. schedule cancel/no_show도 session lock을
      // 사용하므로 두 명령은 in-memory FIFO와 Postgres advisory lock에서 같은 순서로 직렬화된다.
      const scoped = await this.reportFromDb(id);
      await this.uow.lockTargets(sessionAccountingLockKeys({
        sessionIds: [scoped.sessionId],
        reportIds: [id],
      }));
      const r = await this.reportFromDb(id); // [C1] lock 뒤 DB 재조회
      if (r.approvalStatus !== 'submitted')
        throw new BadRequestException(`승인 불가 상태(${r.approvalStatus ?? r.status}) — submitted만 승인 가능`);
      const session = await this.sessionsStore.findByIdDb(r.sessionId);
      if (!session)
        throw new ConflictException('연결된 수업을 찾을 수 없어 보고서를 승인할 수 없습니다.');
      if (session.status === 'canceled' || session.status === 'no_show') {
        this.transitionLog.warn(
          `action=approve report=${id} session=${r.sessionId} actor=${approvedBy ?? 0} result=conflict(session:${session.status})`,
        );
        throw new ConflictException({
          code: 'SESSION_TERMINAL',
          message: `취소/결강 처리된 수업(${session.status})의 보고서는 승인할 수 없습니다.`,
          sessionId: session.id,
          sessionStatus: session.status,
        });
      }
      // [C1] CAS: submitted에서만 approved 전이 — approve-vs-reject 경쟁 시 정확히 1승자(패자 409).
      const after = await this.store.updateIf<SessionReportRow>(SESSION_REPORTS_SPEC, id, { approvalStatus: 'submitted' }, {
        approvalStatus: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy,
      });
      if (!after) {
        this.transitionLog.warn(`action=approve report=${id} actor=${approvedBy ?? 0} result=conflict(cas)`);
        throw new ConflictException('보고서 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      }
      this.transitionLog.log(`action=approve report=${id} actor=${approvedBy ?? 0} transition=submitted->approved`);
      // 보고서 승인은 출결 사실을 대체하지 않는다. 다만 이미 강사·수강생 출결이 모두 완결된
      // scheduled 세션이면 같은 완결 정책으로 held 전이를 마무리한다.
      const [attendance, enrollments] = await Promise.all([
        this.store.findActive<Attendance>(ATTENDANCE_SPEC, {
          where: { sessionId: session.id } as Partial<Attendance>,
        }),
        this.store.findActive<Enrollment>(ENROLLMENTS_SPEC),
      ]);
      const holdPatch = attendanceCompletionHoldPatch(
        session,
        buildCohortIndex(enrollments),
        attendance,
        Date.now(),
      );
      if (holdPatch) {
        const held = await this.sessionsStore.update(after.sessionId, holdPatch as never);
        if (!held)
          throw new ConflictException('수업 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
        this.transitionLog.log(`action=approve report=${id} session=${after.sessionId} autoHeld=1`);
        if (approvedBy != null && approvedBy > 0) {
          await this.audit.log({
            entity: 'class_sessions', entityId: after.sessionId, action: 'update', actorId: approvedBy,
            changes: { status: { before: 'scheduled', after: 'held' } },
            reason: '강사와 수강생 출결 완결 자동 진행 처리',
          });
        }
      }
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
  //  [C1] 존재 판정도 DB — 다른 인스턴스가 만든 보고서도 즉시 반려 가능(메모리 404 제거).
  async reject(id: number, reason?: string, actorId?: number): Promise<SessionReportRow> {
    return this.uow.run(async () => {
      const scoped = await this.reportFromDb(id); // sessionId(불변) 확보 — 404 판정 포함
      // [C1] report + session lock — 반려와 정산 생성(claimPayout)의 적격성 경쟁 보호.
      await this.uow.lockTargets(sessionAccountingLockKeys({
        sessionIds: [scoped.sessionId],
        reportIds: [id],
      }));
      const r = await this.reportFromDb(id); // lock 뒤 DB 재조회
      // [B9 E5 2026-07-16] 종전엔 승인 보고서를 무조건 400("정산 회수 후 처리 필요")으로 막았지만
      //  회수 자체가 미구현이라 사실상 영구 잠금이었다. 이제 payout reversal이 있으므로 게이트를
      //  실제 조건으로 정정: **세션이 정산에 연결돼 있을 때만** 차단(회수하면 연결이 풀려 반려 가능).
      //  [C1] 판정 소스 = 세션 DB 재조회(다른 인스턴스의 정산 연결도 즉시 반영 — 메모리 판정 금지).
      if (r.approvalStatus === 'approved') {
        const session = (await this.sessionsStore.findByIdDb(r.sessionId)) as (ClassSession & { payoutId?: number | null }) | undefined;
        if (session?.payoutId != null)
          throw new BadRequestException('이미 승인됨 + 정산 연결 — 반려하려면 지급 회수(reverse) 후 처리하세요');
      }
      const beforeStatus = r.approvalStatus ?? r.status;
      // [C1] approval_status CAS — approve-vs-reject 경쟁 시 정확히 1승자(모순 audit 0).
      const after = await this.store.updateIf<SessionReportRow>(SESSION_REPORTS_SPEC, id, { approvalStatus: r.approvalStatus }, {
        approvalStatus: 'rejected',
        rejectedReason: reason ?? '사유 미기재',
      });
      if (!after) {
        this.transitionLog.warn(`action=reject report=${id} actor=${actorId ?? 0} result=conflict(cas)`);
        throw new ConflictException('보고서 상태가 이미 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      }
      this.transitionLog.log(`action=reject report=${id} actor=${actorId ?? 0} transition=${beforeStatus}->rejected`);
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
    const rows = await this.store.findActive<SessionReportRow>(SESSION_REPORTS_SPEC, {
      where: { sessionId } as Partial<SessionReportRow>,
      orderBy: { field: 'id' },
    });
    const count = await this.store.removeByField(SESSION_REPORTS_SPEC, 'sessionId', sessionId, deletedBy);
    if (deletedBy != null && deletedBy > 0) {
      for (const r of rows) {
        await this.audit.log({ entity: 'session_reports', entityId: r.id, action: 'delete', actorId: deletedBy });
      }
    }
    return count;
  }
}
