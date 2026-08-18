// [TBO-69 C1 2026-07-26] 스케줄 **명령(Command) 서비스** — 읽기(hydrate·lookup·enrich·목록·검증)는
//  schedule-read.service로 분리(본문 이동 — 규약 무변). 명령은 읽기를 단방향 주입해 경유한다.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  Conflict,
  CreateScheduleSeriesResult,
  OpenClassInput,
  OpenClassResult,
  OpenClassSeriesInput,
  OpenClassSeriesResult,
  CreateHistoricalCompletedSessionInput,
  HistoricalCompletedSessionResult,
  RoleCapability,
  ScheduleRow,
  ScheduleSeries,
  SetInstructorAttendanceInput,
  ClearInstructorAttendanceInput,
  UpdateSessionInstructorAssignmentInput,
  UpdateSessionInstructorAssignmentResult,
} from '@kms545487/contracts';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { RoomsService } from '../rooms/rooms.service';
import { AvailabilityService } from '../availability/availability.service';
import { AuditService } from '../audit/audit.service';
import { AttendanceService } from '../attendance/attendance.service';
import { ReportsService } from '../reports/reports.service';
import { ClassSession, SESSIONS } from './schedule.entity';
import { detectConflicts } from './conflict.util';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { CoursesService } from '../courses/courses.service';
import { ClassSessionsStore } from './class-sessions.store';
import { ScheduleReadService, SESSION_DEFAULTS } from './schedule-read.service'; // [TBO-69 C1]
import { CLASS_SESSION_SERIES, type ScheduleSeriesRow } from './schedule-series.entity';
import { selectSeriesScope, type SeriesScope } from './series-scope.policy';
import { addMinutesGuarded, normalizeSessionTime, sessionEndPassed, storedEndTimeOf } from './session-time.policy';
import { CreateScheduleSeriesDto } from './dto/create-schedule-series.dto';
import {
  CalendarUnitOfWork,
  sessionAccountingLockKeys,
  type CalendarLockKey,
} from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CLASS_SESSION_SERIES_SPEC } from '../../database/calendar-asset-specs';
import {
  accountingImpactOf,
  accountingImpactOfRemoval,
  accountingImpactHash,
  combineAccountingImpacts,
  isPayoutLocked,
  payoutIdOf,
  type SessionAccountingImpact,
} from './session-accounting.policy';
import { isProduction } from '../../common/env';
import { SessionAccountingContextService } from './session-accounting-context.service';
import {
  attendanceCompletionHoldPatch,
  hasSessionTemporalChange,
  isManualCompletionStatusViolation,
  isTemporalChangeBlockedStatus,
  TEMPORAL_RESET_AUDIT_REASON,
} from './session-temporal-transition.policy';

export const canForceScheduleConflicts = (requested?: boolean): boolean =>
  requested === true && !isProduction();
// [R-3 함수 통일] 시간·날짜 primitive는 common/time.util 단일 소스(로컬 중복 제거).
//  로컬 이름과 동일하게 별칭 → 호출부 무변경. addMinutes는 가드형이라 로컬 유지(아래).
import { hhmmToMin as toMin, weekdayOf, addDaysISO, dayDiff } from '../../common/time.util';

// [감사 A, 2026-07-02] 하드코딩 상수(STUDENTS_LBL/COURSE_STUDENTS/COURSES/SUBJECTS) 제거 —
//  코호트·카탈로그는 실제 컬렉션(students/enrollments/courses/subjects)을 조회한다(단일 소스).
//  이전엔 상수 + `status !== 'drop'`(존재하지 않는 상태값 — 실제 소프트삭제는 'canceled') 필터라
//  학생 삭제·신규 수강이 캘린더에 반영되지 않는 무결성 버그가 있었다.
// [강사 식별자 통일 2026-07-07] 강사 = users(role='instructor'), 강사 id = users.id.
//  하드코딩 INSTRUCTORS 상수/브리지 폐기 — 이름/검증/피커는 instructorUsers/instructorName/isInstructor 헬퍼로 users 조회.

// [TBO-69 C1] SESSION_DEFAULTS·SUBJECT_FALLBACK_COLOR는 schedule-read.service로 이동(enrich 소유).

// ── [TBO-29C C4] 시간 정규화는 session-time.policy가 단일 소스 — 로컬 사본(addMinutes/endTimeOf/
//  assertDuration/CROSS_MAX_MIN)을 폐기하고 별칭으로 위임한다. 자정 크로스 endTime은 **명시 null**
//  (undefined는 PG UPDATE payload에서 skip돼 이전 end_time이 잔존 — 메모리/PG 투영 편차의 근본 원인).
const addMinutes = addMinutesGuarded;
const endTimeOf = storedEndTimeOf;

type ScheduleMutationResult = {
  row: ScheduleRow;
  conflicts: Conflict[];
  updated: number;
  accountingImpact?: SessionAccountingImpact;
  accountingImpactHash?: string;
};

// 병합된 세션 필드(업데이트 적용 단위) — 이동/리사이즈/편집 공통.
type MergedFields = {
  studentIds?: number[]; // 명시 코호트(v0.1.13)
  // [R-9→C4] endTime은 자정 크로스(익일 종료)면 **명시 null** — durationMinutes 파생(단일 세션 모델).
  //  undefined는 PG UPDATE에서 skip돼 이전 값이 잔존하므로 update 경로는 null을 강제한다.
  sessionDate: string; startTime: string; endTime?: string | null; durationMinutes: number;
  courseId: number; instructorId: number | null; roomId?: number; status: ClassSession['status']; topic?: string; memo?: string; color?: string;
  instructorAttendance?: ClassSession['instructorAttendance'] | null;
  kind?: ClassSession['kind']; price?: number; // [v0.1.14]
  mode?: ClassSession['mode']; // [v0.1.16] 수업방식
  isPublic?: boolean;
};

@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly sessions: ClassSessionsStore,
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly rooms: RoomsService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService, // [TBO-16 #7] 세션 CRUD 변경 이력(tx 동반)
    private readonly attendance: AttendanceService,
    private readonly reports: ReportsService,
    private readonly collections: PostgresCollectionStore, // [TBO-28F] users 투영 재조회(교차 인스턴스 정합)
    private readonly courses: CoursesService,
    private readonly read: ScheduleReadService, // [TBO-69 C1] 읽기 단방향 주입
    private readonly accountingContext: SessionAccountingContextService,
  ) {}

  private assertCompletionStatusCommand(
    current: ClassSession['status'] | undefined,
    requested: ClassSession['status'] | undefined,
  ): void {
    if (!isManualCompletionStatusViolation(current, requested)) return;
    throw new BadRequestException({
      code: 'SESSION_STATUS_FACT_MISMATCH',
      message: '진행 완료 상태는 수업 종료 후 강사·학생 출결이 모두 입력될 때 자동으로 전이됩니다.',
    });
  }

  // [TBO-28C] 캘린더 명령의 advisory lock 키 — 대상 강사·강의실·학생·세션. UoW.lockTargets가 정렬·중복 제거.
  private calendarLockKeys(t: {
    instructorIds?: Array<number | null | undefined>;
    roomIds?: Array<number | undefined>;
    studentIds?: number[];
    sessionIds?: number[];
  }): CalendarLockKey[] {
    const keys: CalendarLockKey[] = [];
    for (const id of t.instructorIds ?? []) if (id != null) keys.push({ kind: 'instructor', id });
    for (const id of t.roomIds ?? []) if (id != null) keys.push({ kind: 'room', id });
    for (const id of t.studentIds ?? []) keys.push({ kind: 'student', id });
    for (const id of t.sessionIds ?? []) keys.push({ kind: 'session', id });
    return keys;
  }

  /** [TBO-28C] 잠금 획득 직후 권위 DB에서 세션·가용 투영을 재조회(다른 요청/인스턴스의 커밋 반영). */
  private async refreshAfterLock(): Promise<void> {
    await this.read.ensureReady();
  }

  /** 과목 text input → subject/course/session 단일 transaction. 참가자는 enrollment와 독립이다. */
  async openClass(dto: OpenClassInput, actorId?: number): Promise<OpenClassResult> {
    await this.read.ensureReady();
    const studentIds = [...new Set((dto.studentIds ?? []).map(Number))];
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([
        this.courses.subjectNameLockKey(dto.subjectName),
        ...(dto.instructorId == null ? [] : [{ kind: 'user' as const, id: dto.instructorId }]),
        ...this.calendarLockKeys({ instructorIds: [dto.instructorId], roomIds: [dto.roomId], studentIds }),
      ]);
      await this.refreshAfterLock();
      const { subject, course } = await this.courses.resolveSubjectCourse({
        subjectName: dto.subjectName,
        instructorId: dto.instructorId,
        hourlyRateOverride: dto.hourlyRateOverride,
        coursePrice: dto.coursePrice,
        isKinder: dto.isKinder,
        color: dto.color,
      }, actorId);
      const { row, conflicts } = await this.create({
        courseId: course.id,
        instructorId: dto.instructorId,
        roomId: dto.roomId,
        sessionDate: dto.sessionDate,
        startTime: dto.startTime,
        endTime: dto.endTime,
        durationMinutes: dto.durationMinutes,
        studentIds,
        topic: dto.topic,
        memo: dto.memo,
        color: dto.color,
        status: dto.status,
        force: dto.force,
        kind: dto.kind,
        price: dto.price,
        mode: dto.mode,
        isPublic: dto.isPublic,
      }, actorId);
      return { subject, course, row, conflicts };
    });
  }

  /** 과목 text input → subject/course + 기존 원자 bulk series command 재사용. */
  async openClassSeries(dto: OpenClassSeriesInput, actorId?: number): Promise<OpenClassSeriesResult> {
    await this.read.ensureReady();
    const studentIds = [...new Set((dto.studentIds ?? []).map(Number))];
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([
        this.courses.subjectNameLockKey(dto.subjectName),
        ...(dto.instructorId == null ? [] : [{ kind: 'user' as const, id: dto.instructorId }]),
        ...this.calendarLockKeys({ instructorIds: [dto.instructorId], roomIds: [dto.roomId], studentIds }),
      ]);
      await this.refreshAfterLock();
      const { subject, course } = await this.courses.resolveSubjectCourse({
        subjectName: dto.subjectName,
        instructorId: dto.instructorId,
        hourlyRateOverride: dto.hourlyRateOverride,
        coursePrice: dto.coursePrice,
        isKinder: dto.isKinder,
        color: dto.color,
      }, actorId);
      const result = await this.createSeries({
        courseId: course.id,
        instructorId: dto.instructorId,
        roomId: dto.roomId,
        studentIds,
        repeat: dto.repeat,
        startTime: dto.startTime,
        endTime: dto.endTime,
        durationMinutes: dto.durationMinutes,
        timeZone: dto.timeZone,
        topic: dto.topic,
        memo: dto.memo,
        color: dto.color,
        status: dto.status,
        kind: dto.kind,
        price: dto.price,
        mode: dto.mode,
        isPublic: dto.isPublic,
        force: dto.force,
      }, actorId);
      return { subject, course, ...result };
    });
  }

  async create(dto: {
    courseId: number; instructorId?: number | null; roomId?: number; sessionDate: string;
    startTime: string; endTime?: string; durationMinutes?: number; topic?: string; memo?: string; color?: string;
    studentIds?: number[]; // 명시 코호트(v0.1.13)
    seriesId?: number; status?: ClassSession['status']; force?: boolean;
    kind?: ClassSession['kind']; price?: number; // [v0.1.14] 종류·세션 단건 가격
    mode?: ClassSession['mode']; // [v0.1.16] 수업방식(기본 in_person)
    isPublic?: boolean;
    makeupForSessionId?: number; // [대표 지시 ⑭ 2026-07-16] 보강 세션 → 원본(결강) 세션 링크
  }, actorId?: number, options?: { auditReason?: string }): Promise<{ row: ScheduleRow; conflicts: Conflict[] }> {
    await this.read.ensureReady();
    this.assertCompletionStatusCommand(undefined, dto.status);
    const instructorId = this.read.validateSessionInput(dto); // FK·코호트 공통 검증(함수 통일)
    const course = this.read.courseOf(dto.courseId)!;
    const studentIds = dto.studentIds !== undefined ? dto.studentIds : this.read.activeStudentIds(dto.courseId);

    // [C4] 시간 정규화 단일 진입점 — endTime<startTime=익일 종료, 크로스=endTime null(duration 파생 저장)
    const { startTime, durationMinutes, endTime } = normalizeSessionTime(
      { startTime: dto.startTime, endTime: dto.endTime, durationMinutes: dto.durationMinutes });

    // [TBO-28C] 충돌 검사를 **tx 안으로**(잠금→권위 재조회→재검증) — read-check-then-write 레이스 차단.
    //  서로 다른 두 클라이언트/인스턴스의 겹치는 create는 advisory lock에서 직렬화되어 정확히 하나만 성공(409).
    const { row, conflicts } = await this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets(this.calendarLockKeys({
        instructorIds: [instructorId], roomIds: [dto.roomId], studentIds,
      }));
      await this.refreshAfterLock();
      // [TBO-79 D3] 잠금 후 FK·코호트 재검증 — 종전엔 create만 잠금 **전** 1회 검증이었다.
      //  같은 파일의 update는 잠금 후 재검증하는데 create는 아니어서, 동시에 코스 삭제·강사
      //  비활성화·수강 취소가 커밋되면 stale FK 위에 세션이 삽입될 수 있었다(비대칭).
      this.read.validateSessionInput({ ...dto, studentIds });
      if (dto.seriesId != null && !this.db.findById<ScheduleSeriesRow>(CLASS_SESSION_SERIES, dto.seriesId))
        throw new BadRequestException(`seriesId ${dto.seriesId} 없음 — 반복 생성은 POST /schedule/series를 사용하세요`);
      // [대표 지시 ⑭] 보강 링크 참조 무결성 — 원본 세션이 실존(미삭제)해야 하고, 보강 세션을 다시
      //  원본으로 가리키는 체이닝은 금지(해소 판정 그래프 단순화 — 원본↔보강 1단 링크만).
      if (dto.makeupForSessionId != null) {
        const original = this.db.findById<ClassSession>(SESSIONS, dto.makeupForSessionId);
        if (!original) throw new BadRequestException(`보강 원본 세션 ${dto.makeupForSessionId} 없음`);
        if (original.makeupForSessionId != null)
          throw new BadRequestException('보강 세션을 원본으로 지정할 수 없습니다. 결강된 원 수업을 지정해 주세요.');
      }
      const conflicts = detectConflicts(
        { sessionDate: dto.sessionDate, startTime, durationMinutes, instructorId: instructorId ?? undefined, roomId: dto.roomId, studentIds, mode: dto.mode ?? SESSION_DEFAULTS.mode },
        this.db.findAll<ClassSession>(SESSIONS),
        this.availability.list(),
        this.read.effectiveStudentIds,
        (roomId) => this.rooms.capacityOf(roomId), // [B4] 정원 강제
      );
      // 디버깅: 생성 요청 + 충돌 현황 로깅
      if (conflicts.length && !canForceScheduleConflicts(dto.force)) {
        this.logger.warn(`create 충돌 ${conflicts.length}건 — course=${dto.courseId} ${dto.sessionDate} ${dto.startTime}`);
        throw new ConflictException({ message: '스케줄 충돌', conflicts });
      }

      // [원자성] 세션 생성 + 변경 이력(audit)이 함께 반영되거나 함께 롤백
      const created = await this.sessions.insert({
        studentIds,
        seriesId: dto.seriesId,
        courseId: dto.courseId,
        instructorId,
        roomId: dto.roomId,
        sessionDate: dto.sessionDate,
        startTime,
        endTime,
        durationMinutes,
        status: dto.status ?? SESSION_DEFAULTS.status,
        kind: dto.kind ?? SESSION_DEFAULTS.kind, // [v0.1.14] 기본 class(하위호환)
        mode: dto.mode ?? SESSION_DEFAULTS.mode, // [v0.1.16] 기본 대면(하위호환)
        isPublic: dto.isPublic ?? false,
        makeupForSessionId: dto.makeupForSessionId, // [대표 지시 ⑭] 보강→원본 링크(해소 판정 근거)
        price: dto.price,
        topic: dto.topic ?? course.name,
        memo: dto.memo,
        color: dto.color ?? course.color,
      } as Omit<ClassSession, keyof BaseRow>);
      if (actorId != null)
        await this.audit.log({
          entity: SESSIONS,
          entityId: created.id,
          action: 'create',
          actorId,
          changes: this.audit.snapshotOf(created) as never,
          reason: options?.auditReason,
        });
      return { row: created, conflicts };
    });
    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return { row: this.read.enrich(row, roomsMap), conflicts };
  }

  /**
   * [TBO-86D] 과거 완료 수업 이관 command.
   * 일반 create의 held 직접 주입 금지는 유지하고, 기존 세션 생성/강사 출결/학생 출결 command를
   * 하나의 UoW에서 실행해 출결 완결 정책이 held를 파생하도록 한다. 어느 audit라도 실패하면 전부 롤백된다.
   */
  async createHistoricalCompleted(
    dto: CreateHistoricalCompletedSessionInput,
    actorId?: number,
    actorCapabilities: RoleCapability[] = [],
  ): Promise<HistoricalCompletedSessionResult> {
    if (actorId == null
      || !actorCapabilities.includes('calendar.manage')
      || !actorCapabilities.includes('session-attendance.manage')) {
      throw new ForbiddenException('과거 완료 수업 이관은 캘린더와 수업 출결 관리 권한이 필요합니다.');
    }
    const importReason = dto.importReason.trim();
    if (importReason.length < 5) throw new BadRequestException('이관 사유는 공백 제외 5자 이상 입력해 주세요.');
    if (new Set(dto.studentIds).size !== dto.studentIds.length) {
      throw new BadRequestException('학생은 중복 선택할 수 없습니다.');
    }
    await this.read.ensureReady();
    const normalized = normalizeSessionTime({
      startTime: dto.startTime,
      endTime: dto.endTime,
      durationMinutes: dto.durationMinutes,
    });
    if (!sessionEndPassed({
      sessionDate: dto.sessionDate,
      startTime: normalized.startTime,
      durationMinutes: normalized.durationMinutes,
    }, Date.now())) {
      throw new BadRequestException({
        code: 'HISTORICAL_SESSION_NOT_ENDED',
        message: '종료된 과거 수업만 완료 상태로 이관할 수 있습니다.',
      });
    }
    if (dto.kind === 'counsel') {
      throw new BadRequestException('상담 일정은 강사·학생 출결 기반 완료 수업 이관 대상이 아닙니다.');
    }

    return this.unitOfWork.run(async () => {
      const { importReason: omittedImportReason, ...createInput } = dto;
      void omittedImportReason;
      const created = await this.create(createInput, actorId, {
        auditReason: `과거 완료 수업 이관: ${importReason}`,
      });

      await this.setInstructorAttendance(
        created.row.id,
        { status: 'present' },
        actorId,
        actorCapabilities,
      );
      const attendance: HistoricalCompletedSessionResult['attendance'] = [];
      for (const studentId of dto.studentIds) {
        attendance.push(await this.attendance.upsert({
          sessionId: created.row.id,
          studentId,
          status: 'present',
        }, actorId, actorCapabilities));
      }

      const final = await this.sessions.findByIdDb(created.row.id);
      if (!final || final.status !== 'held' || final.instructorAttendance !== 'present') {
        throw new ConflictException({
          code: 'HISTORICAL_SESSION_TRANSITION_INCOMPLETE',
          message: '출결 사실이 완결되지 않아 과거 수업 이관을 취소했습니다.',
        });
      }
      const roomsMap = new Map(this.rooms.findAll().map((room) => [room.id, room]));
      this.logger.log(
        `action=create_historical_completed session=${final.id} actor=${actorId} students=${attendance.length} result=success`,
      );
      return {
        row: this.read.enrich(final, roomsMap),
        conflicts: created.conflicts,
        attendance,
      };
    });
  }

  /**
   * [TBO-86E] 배정중 회차 사후 배정 command.
   * session/course/기존·신규 강사를 한 lock 공간에서 읽고 충돌을 다시 계산한 뒤 회차·선택적 코스·audit를
   * 함께 커밋한다. 배정만으로 과거 회차를 held로 만들거나 출결을 추정하지 않는다.
   */
  async updateInstructorAssignment(
    sessionId: number,
    dto: UpdateSessionInstructorAssignmentInput,
    actorId?: number,
  ): Promise<UpdateSessionInstructorAssignmentResult> {
    if (actorId == null) throw new ForbiddenException('담당자 배정에는 로그인 사용자 정보가 필요합니다.');
    await this.read.ensureReady();
    const preliminary = this.db.findById<ClassSession>(SESSIONS, sessionId);
    if (!preliminary) throw new NotFoundException(`Session ${sessionId} not found`);

    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([
        { kind: 'session', id: sessionId },
        { kind: 'course', id: preliminary.courseId },
        ...this.calendarLockKeys({ instructorIds: [preliminary.instructorId, dto.instructorId] }),
      ]);
      await this.refreshAfterLock();
      const current = await this.sessions.findByIdDb(sessionId);
      if (!current) throw new NotFoundException(`Session ${sessionId} not found`);
      if (current.courseId !== preliminary.courseId) {
        throw new ConflictException({
          code: 'INSTRUCTOR_ASSIGNMENT_STALE',
          message: '수업 과목이 이미 변경되었습니다. 최신 수업을 다시 확인해 주세요.',
          currentCourseId: current.courseId,
        });
      }
      const hasExpected = Object.prototype.hasOwnProperty.call(dto, 'expectedInstructorId');
      if (hasExpected && current.instructorId !== dto.expectedInstructorId) {
        throw new ConflictException({
          code: 'INSTRUCTOR_ASSIGNMENT_STALE',
          message: '담당 강사가 이미 변경되었습니다. 최신 수업을 다시 확인해 주세요.',
          currentInstructorId: current.instructorId,
        });
      }
      if (current.instructorId === dto.instructorId) {
        throw new BadRequestException('현재 담당 강사와 동일합니다.');
      }
      const previousInstructorId = current.instructorId;
      if (current.payoutId != null || current.paidPayoutId != null || current.isPaid === true) {
        throw new ConflictException('정산 연결 또는 지급 완료 회차는 담당자를 변경할 수 없습니다.');
      }
      const context = await this.accountingContext.loadFresh([sessionId]);
      this.accountingContext.assertDependentsCompatible(context, current, {
        courseId: current.courseId,
        studentIds: current.studentIds,
        instructorId: dto.instructorId,
      });
      if (dto.instructorId == null) {
        if (dto.setCourseDefault) throw new BadRequestException('배정중 전환과 코스 기본 담당자 갱신을 함께 요청할 수 없습니다.');
        if (current.status === 'held' || current.status === 'makeup' || current.instructorAttendance != null
          || current.instructorPayAmount != null || this.accountingContext.attendanceFor(context, sessionId).length > 0) {
          throw new ConflictException('출결·완료·책정 이력이 있는 회차는 배정중으로 되돌릴 수 없습니다.');
        }
      } else {
        if (!this.read.isScheduleOwner(dto.instructorId)) {
          throw new BadRequestException(`instructorId ${dto.instructorId}는 활성 강사 또는 대표가 아닙니다`);
        }
        const conflicts = detectConflicts(
          {
            sessionDate: current.sessionDate,
            startTime: current.startTime!,
            endTime: current.endTime,
            durationMinutes: current.durationMinutes,
            instructorId: dto.instructorId,
            roomId: current.roomId,
            studentIds: current.studentIds ?? this.read.activeStudentIds(current.courseId),
            ignoreSessionId: current.id,
            mode: current.mode,
          },
          this.db.findAll<ClassSession>(SESSIONS),
          this.availability.list(),
          this.read.effectiveStudentIds,
          (roomId) => this.rooms.capacityOf(roomId),
        );
        if (conflicts.length) throw new ConflictException({ message: '담당 강사 일정과 충돌합니다.', conflicts });
      }

      const saved = await this.sessions.update(sessionId, { instructorId: dto.instructorId });
      if (!saved) throw new ConflictException('담당자 배정 중 회차가 변경되었습니다. 다시 시도해 주세요.');
      if (dto.setCourseDefault && dto.instructorId != null) {
        await this.courses.update(current.courseId, { instructorId: dto.instructorId }, actorId);
      }
      await this.audit.log({
        entity: SESSIONS,
        entityId: sessionId,
        action: 'update',
        actorId,
        changes: { instructorId: { before: previousInstructorId, after: dto.instructorId } },
        reason: dto.reason.trim(),
      });
      return {
        row: this.read.enrich(saved, new Map(this.rooms.findAll().map((room) => [room.id, room]))),
        previousInstructorId,
        courseDefaultUpdated: dto.setCourseDefault === true && dto.instructorId != null,
      };
    });
  }

  /** [TBO-29C C2] 반복 규칙 -> occurrence 날짜 정규화(순수) — [startsOn, endsOn]에서 weekdays에 속하는 날짜.
   *  범위 366일·회차 120건 상한(운영 가드). weekly는 요일 1개 강제. */
  static occurrenceDatesOf(repeat: { kind: 'weekly' | 'custom'; weekdays: number[]; startsOn: string; endsOn: string }): string[] {
    if (repeat.startsOn > repeat.endsOn) throw new BadRequestException('startsOn은 endsOn보다 늦을 수 없습니다');
    if (repeat.kind === 'weekly' && repeat.weekdays.length !== 1)
      throw new BadRequestException('weekly 반복은 요일을 정확히 1개 지정합니다');
    if (dayDiff(repeat.startsOn, repeat.endsOn) > 366) throw new BadRequestException('반복 기간은 최대 366일입니다');
    const wanted = new Set(repeat.weekdays);
    const dates: string[] = [];
    for (let d = repeat.startsOn; d <= repeat.endsOn; d = addDaysISO(d, 1)) {
      if (wanted.has(weekdayOf(d))) dates.push(d);
      if (dates.length > 120) throw new BadRequestException('반복 회차는 최대 120건입니다');
    }
    if (!dates.length) throw new BadRequestException('반복 기간 안에 해당 요일이 없습니다');
    return dates;
  }

  /** [TBO-29C C2] 반복 생성 bulk command — 서버가 series ID를 발급하고 규칙/날짜/기간/시간/cohort/FK를
   *  전체 정규화한 뒤, 모든 자원 lock -> 권위 재조회 -> **전체 conflict 선계산** -> series+occurrence+audit를
   *  **한 transaction**으로 저장한다. 중간 실패는 전부 롤백(series +0, sessions +0, audit +0). */
  async createSeries(dto: CreateScheduleSeriesDto, actorId?: number): Promise<CreateScheduleSeriesResult> {
    await this.read.ensureReady();
    this.assertCompletionStatusCommand(undefined, dto.status);
    const instructorId = this.read.validateSessionInput(dto); // FK·코호트 공통 검증(단건 create와 같은 함수)
    const course = this.read.courseOf(dto.courseId)!;
    const studentIds = dto.studentIds !== undefined ? dto.studentIds : this.read.activeStudentIds(dto.courseId);
    const timeZone = dto.timeZone ?? 'Asia/Seoul';
    if (timeZone !== 'Asia/Seoul') throw new BadRequestException('반복 규칙 시간대는 MVP에서 Asia/Seoul만 지원합니다');

    // [C4] 시간 정규화 단일 진입점(session-time.policy)
    const { startTime, durationMinutes, endTime } = normalizeSessionTime(
      { startTime: dto.startTime, endTime: dto.endTime, durationMinutes: dto.durationMinutes });
    const weekdays = [...new Set(dto.repeat.weekdays)].sort((a, b) => a - b);
    const dates = ScheduleService.occurrenceDatesOf({ ...dto.repeat, weekdays });

    const result = await this.unitOfWork.run(async () => {
      // 모든 자원 lock을 결정적 순서로(강사·강의실·학생) — 회차 전체가 같은 자원 집합을 공유.
      await this.unitOfWork.lockTargets(this.calendarLockKeys({
        instructorIds: [instructorId], roomIds: [dto.roomId], studentIds,
      }));
      await this.refreshAfterLock();

      // 단건 create와 동일하게 잠금 후 권위 학생 상태를 다시 검증한다.
      this.read.validateSessionInput({ ...dto, studentIds });

      // 전체 conflict 선계산 — 어떤 회차도 쓰기 전에 모든 날짜를 검사(부분 커밋 원천 차단).
      const existing = this.db.findAll<ClassSession>(SESSIONS);
      const allConflicts: Conflict[] = [];
      for (const sessionDate of dates) {
        allConflicts.push(...detectConflicts(
          { sessionDate, startTime, durationMinutes, instructorId: instructorId ?? undefined, roomId: dto.roomId, studentIds, mode: dto.mode ?? SESSION_DEFAULTS.mode },
          existing,
          this.availability.list(),
          this.read.effectiveStudentIds,
        (roomId) => this.rooms.capacityOf(roomId), // [B4] 정원 강제
        ));
      }
      if (allConflicts.length && !canForceScheduleConflicts(dto.force)) {
        this.logger.warn(`createSeries 충돌 ${allConflicts.length}건 — course=${dto.courseId} ${dates[0]}~${dates[dates.length - 1]} ${startTime}`);
        throw new ConflictException({ message: '스케줄 충돌', conflicts: allConflicts });
      }

      // 서버 발급 series ID — 규칙·생성자·기간을 자산화(audit 포함 원자성).
      const series = await this.collections.insert<ScheduleSeriesRow>(CLASS_SESSION_SERIES_SPEC, {
        repeatKind: dto.repeat.kind,
        weekdays,
        startsOn: dto.repeat.startsOn,
        endsOn: dto.repeat.endsOn,
        startTime,
        durationMinutes,
        timeZone,
        version: 1,
        createdBy: actorId ?? null,
        updatedBy: null,
      });
      if (actorId != null)
        await this.audit.log({ entity: CLASS_SESSION_SERIES, entityId: series.id, action: 'create', actorId, changes: this.audit.snapshotOf(series) as never });

      const rows: ClassSession[] = [];
      for (const sessionDate of dates) {
        const created = await this.sessions.insert({
          studentIds,
          seriesId: series.id,
          courseId: dto.courseId,
          instructorId,
          roomId: dto.roomId,
          sessionDate,
          startTime,
          endTime,
          durationMinutes,
          status: dto.status ?? SESSION_DEFAULTS.status,
          kind: dto.kind ?? SESSION_DEFAULTS.kind,
          mode: dto.mode ?? SESSION_DEFAULTS.mode,
          isPublic: dto.isPublic ?? false,
          price: dto.price,
          topic: dto.topic ?? course.name,
          memo: dto.memo,
          color: dto.color ?? course.color,
        } as Omit<ClassSession, keyof BaseRow>);
        if (actorId != null)
          await this.audit.log({ entity: SESSIONS, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
        rows.push(created);
      }
      return { series, rows, conflicts: allConflicts };
    });

    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    const seriesOut: ScheduleSeries = {
      id: result.series.id,
      repeatKind: result.series.repeatKind,
      weekdays: result.series.weekdays,
      startsOn: result.series.startsOn,
      endsOn: result.series.endsOn,
      startTime: result.series.startTime,
      durationMinutes: result.series.durationMinutes,
      timeZone: result.series.timeZone,
      version: result.series.version,
      createdBy: result.series.createdBy ?? undefined,
      updatedBy: result.series.updatedBy ?? undefined,
    };
    return { series: seriesOut, rows: result.rows.map((r) => this.read.enrich(r, roomsMap)), conflicts: result.conflicts };
  }

  // 세션 삭제 — [v9] soft delete(행 보존·deletedBy 기록) + audit before 스냅샷 + 동반 정리(출결·리포트) 단일 tx.
  //  [TBO-28C] 대상 세션 잠금 + 잠금 후 권위 재조회(동시 update/delete 경쟁 직렬화 — payout-lock 판정도 tx 안).
  //  [TBO-29C C3] scope(this/this_and_following/all) 지원 — 대상 집합은 selectSeriesScope(순수),
  //  payout lock·의존 cascade는 **삭제 전 전 회차 사전 검증**(하나라도 걸리면 아무것도 삭제하지 않음),
  //  회차별 audit(before 스냅샷)+공통 correlation, series version CAS/endsOn 축소/전량 삭제 시 series soft delete.
  async remove(
    id: number,
    actorId?: number,
    opts?: {
      scope?: SeriesScope;
      expectedSeriesVersion?: number;
      acknowledgeAccountingImpact?: boolean;
      expectedAccountingImpactHash?: string;
      expectedTargetIds?: readonly number[];
    },
  ): Promise<{
    id: number;
    deleted: boolean;
    removedIds: number[];
    accountingImpact?: SessionAccountingImpact;
    accountingImpactHash?: string;
  }> {
    await this.read.ensureReady();
    const scope = opts?.scope ?? 'this';
    const pre = this.db.findById<ClassSession>(SESSIONS, id);
    if (!pre) throw new NotFoundException(`Session ${id} not found`);
    return this.unitOfWork.run(async () => {
      if (pre.seriesId != null) {
        await this.unitOfWork.lockTargets([{ kind: 'series', id: Number(pre.seriesId) }]);
      }
      await this.refreshAfterLock();
      const scopedBefore = this.db.findById<ClassSession>(SESSIONS, id);
      if (!scopedBefore) throw new NotFoundException(`Session ${id} not found`);
      const preliminaryCompanions = scope !== 'this' && scopedBefore.seriesId != null
        ? selectSeriesScope(
          this.db.findBy<ClassSession>(SESSIONS, (session) => session.seriesId === scopedBefore.seriesId),
          scopedBefore,
          scope,
        )
        : [];
      await this.unitOfWork.lockTargets(sessionAccountingLockKeys({
        sessionIds: [scopedBefore.id, ...preliminaryCompanions.map((session) => session.id)],
      }));
      await this.refreshAfterLock();
      const before = this.db.findById<ClassSession>(SESSIONS, id);
      if (!before) throw new NotFoundException(`Session ${id} not found`);
      const seriesRow = before.seriesId != null ? this.db.findById<ScheduleSeriesRow>(CLASS_SESSION_SERIES, before.seriesId) : undefined;
      if (opts?.expectedSeriesVersion != null && seriesRow && opts.expectedSeriesVersion !== seriesRow.version) {
        throw new ConflictException({
          code: 'SERIES_VERSION_STALE',
          message: `시리즈가 다른 변경으로 갱신됐습니다(현재 v${seriesRow.version}). 새로고침 후 다시 시도하세요.`,
          currentVersion: seriesRow.version,
        });
      }
      let companions: ClassSession[] = [];
      if (scope !== 'this' && before.seriesId != null) {
        companions = selectSeriesScope(this.db.findBy<ClassSession>(SESSIONS, (s) => s.seriesId === before.seriesId), before, scope);
      }
      const targets = [before, ...companions];
      if (opts?.expectedTargetIds) {
        const expectedTargetIds = [...opts.expectedTargetIds].sort((a, b) => a - b);
        const currentTargetIds = targets.map((target) => target.id).sort((a, b) => a - b);
        if (
          expectedTargetIds.length !== currentTargetIds.length
          || expectedTargetIds.some((targetId, index) => targetId !== currentTargetIds[index])
        ) {
          throw new ConflictException({
            code: 'REQUEST_SCOPE_STALE',
            message: '요청 이후 반복 수업 대상이 변경되었습니다. 현재 범위를 확인한 새 요청이 필요합니다.',
            expectedTargetIds,
            currentTargetIds,
          });
        }
      }
      const accountingContext = await this.accountingContext.loadFresh(targets.map((target) => target.id));
      const accountingImpact = combineAccountingImpacts(targets.map((target) => accountingImpactOfRemoval(
        target,
        // [TBO-79 B1] 정산서 라인 산정과 같은 분류 입력 — 지각·학생 출결 미기록·책정가 반영.
        this.accountingContext.pricingInputFor(
          accountingContext,
          target.id,
          target,
          this.read.courseOf(target.courseId)?.hourlyRate,
        ),
      )));
      const impactHash = accountingImpactHash(targets.map((target) => target.id), accountingImpact);
      // [C3] 전 회차 사전 검증 — 정산 연결이 하나라도 있으면 전체 불변(부분 삭제 금지).
      const locked = targets.filter((t) => isPayoutLocked(t));
      if (locked.length) {
        throw new ConflictException({
          code: 'PAYOUT_REVERSAL_REQUIRED',
          message: `정산서에 연결된 수업(${locked.map((t) => `${t.id}(정산 ${payoutIdOf(t)})`).join(', ')})은 정산 회수 전 삭제할 수 없습니다`,
          sessionIds: locked.map((t) => t.id),
          impact: accountingImpact,
          impactHash,
        });
      }
      if (accountingImpact.changed && (
        !opts?.acknowledgeAccountingImpact
        || opts.expectedAccountingImpactHash !== impactHash
      )) {
        throw new ConflictException({
          code: 'ACCOUNTING_IMPACT_ACK_REQUIRED',
          message: opts?.acknowledgeAccountingImpact
            ? '확인한 회계 영향이 현재 상태와 달라졌습니다. 최신 영향 미리보기를 다시 확인하세요.'
            : '삭제하면 확정 시수 또는 정산 예상 금액이 변경됩니다. 영향 미리보기를 확인하고 다시 승인하세요.',
          impact: accountingImpact,
          impactHash,
        });
      }
      const correlation = before.seriesId != null ? `series=${before.seriesId} scope=${scope} corr=${randomUUID()}` : undefined;
      const removedIds: number[] = [];
      for (const t of targets) {
        const snap = { ...t };
        const deleted = await this.sessions.remove(t.id, actorId);
        // 동반 soft delete(무결성·캐스케이드 — dbml v9 §33): 이 세션의 출결·리포트
        await this.attendance.removeBySession(t.id, actorId);
        await this.reports.removeBySession(t.id, actorId);
        if (deleted) removedIds.push(t.id);
        if (deleted && actorId != null) {
          const changes = this.audit.snapshotOf(snap) as Record<string, { before?: unknown; after?: unknown }>;
          if (t.id === before.id && accountingImpact.changed) {
            changes.accountingImpactAcknowledgement = {
              before: null,
              after: { hash: impactHash, impact: accountingImpact },
            };
          }
          await this.audit.log({ entity: SESSIONS, entityId: t.id, action: 'delete', actorId, changes, reason: correlation });
        }
      }
      // [C3] series 정리: 남은 회차 0 → series soft delete · scope 삭제 → version 전진(+endsOn 축소)
      if (seriesRow) {
        const remaining = this.db.findBy<ClassSession>(SESSIONS, (s) => s.seriesId === seriesRow.id);
        const beforeSeries = { ...seriesRow };
        if (!remaining.length) {
          await this.collections.remove(CLASS_SESSION_SERIES_SPEC, seriesRow.id, actorId);
          if (actorId != null)
            await this.audit.log({ entity: CLASS_SESSION_SERIES, entityId: seriesRow.id, action: 'delete', actorId, changes: this.audit.snapshotOf(beforeSeries) as never, reason: correlation });
        } else if (scope !== 'this') {
          const lastDate = remaining.map((r) => r.sessionDate).sort()[remaining.length - 1];
          const bumped = await this.collections.update<ScheduleSeriesRow>(CLASS_SESSION_SERIES_SPEC, seriesRow.id, {
            version: seriesRow.version + 1,
            updatedBy: actorId ?? null,
            endsOn: scope === 'this_and_following' && lastDate < seriesRow.endsOn ? lastDate : seriesRow.endsOn,
          } as Partial<Omit<ScheduleSeriesRow, keyof BaseRow>>);
          if (actorId != null && bumped)
            await this.audit.log({ entity: CLASS_SESSION_SERIES, entityId: seriesRow.id, action: 'update', actorId, changes: this.audit.diffOf(beforeSeries, bumped) as never, reason: correlation });
        }
      }
      return {
        id,
        deleted: removedIds.includes(id),
        removedIds,
        accountingImpact: accountingImpact.changed ? accountingImpact : undefined,
        accountingImpactHash: accountingImpact.changed ? impactHash : undefined,
      };
    });
  }
  // 이동·리사이즈·상세편집. 충돌 시(force 아니면) 409 + conflicts 반환.
  // scope(this_and_following|all)면 같은 seriesId 세션에 동일 날짜·시간 델타를 함께 적용.
  /** 삭제는 출결·보고서·반복 시리즈 메타를 함께 전이한다.
   * 삭제 배치 스냅샷 없는 단일 세션 restore는 종속 행을 빠뜨리므로 fail-closed 한다. */
  async restoreSession(_id: number, _actorId?: number): Promise<never> {
    throw new ConflictException({
      code: 'SESSION_AGGREGATE_RESTORE_REQUIRED',
      message: '수업 삭제 복구는 출결·보고서·반복 시리즈를 함께 복구하는 배치 기능이 준비될 때까지 사용할 수 없습니다.',
    });
  }

  /** [TBO-64 2026-07-24] 회차 가격 책정(시수 워크시트) — 매니저/대표 전용. lock → DB 재조회 →
   *  가드(held·결석 아님·정산 미연결) → 조건부 UPDATE + audit. null = 책정 해제(자동/빈칸 복귀). */
  async setSessionPayAmount(id: number, amount: number | null, actorId?: number): Promise<{ row: ScheduleRow }> {
    await this.read.ensureReady();
    if (amount != null && (!Number.isInteger(amount) || amount < 0))
      throw new BadRequestException('금액은 0 이상의 정수여야 합니다.');
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([{ kind: 'session', id }]);
      const cur = await this.sessions.findByIdDb(id);
      if (!cur) throw new NotFoundException(`Session ${id} not found`);
      if (cur.instructorId == null) throw new BadRequestException('배정중 수업에는 강사 책정가를 입력할 수 없습니다.');
      if (cur.payoutId != null)
        throw new ConflictException('이미 정산서에 연결된 회차는 금액을 바꿀 수 없습니다(정산 반려/회수 후 재산정).');
      if (cur.status !== 'held')
        throw new BadRequestException('진행 완료(held)된 회차만 금액을 책정할 수 있습니다.');
      if (cur.instructorAttendance === 'absent')
        throw new BadRequestException('강사 결석 회차는 시수 제외라 금액을 책정할 수 없습니다.');
      const updated = await this.sessions.setPayAmount(id, amount);
      if (!updated) throw new ConflictException('다른 요청이 회차를 먼저 변경했습니다. 새로고침 후 다시 시도해 주세요.');
      if (actorId != null) {
        await this.audit.log({
          entity: 'class_sessions', entityId: id, action: 'update', actorId,
          changes: { instructorPayAmount: { before: cur.instructorPayAmount ?? null, after: amount } },
          reason: '시수 워크시트 가격 책정(TBO-64)',
        });
      }
      this.logger.log(
        `action=set_session_pay_amount session=${id} actor=${actorId ?? 0} before=${cur.instructorPayAmount ?? 'null'} after=${amount ?? 'null'} result=success`,
      );
      // [TBO-79 E5] 형제 라우트(update/create)와 같은 **enrich된 행**을 돌려준다. 종전엔 저장 행을
      //  그대로 반환했는데 FE 타입은 조인 필드(courseName·instructorName·missingAttendance…)를
      //  주장하고 있었다 — 드리프트가 반대 방향이었고, 그 필드를 읽는 순간 undefined가 된다.
      const roomsMap = new Map(this.rooms.findAll().map((room) => [room.id, room]));
      return { row: this.read.enrich(updated, roomsMap) };
    });
  }

  async setInstructorAttendance(
    id: number,
    input: SetInstructorAttendanceInput,
    actorId?: number,
    actorCapabilities: RoleCapability[] = [],
    internal?: {
      expectedInstructorAttendance?: ClassSession['instructorAttendance'] | null;
      auditReason?: string;
    },
  ): Promise<ScheduleMutationResult> {
    await this.read.ensureReady();
    if (!actorCapabilities.includes('session-attendance.manage')) {
      throw new ForbiddenException('강사 출결 변경은 수업 출결 관리 권한이 필요합니다.');
    }
    const session = this.db.findById<ClassSession>(SESSIONS, id);
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    if (session.instructorId == null) throw new ConflictException('담당 강사를 배정한 뒤 강사 출결을 입력할 수 있습니다.');
    const expectedAttendance = internal
      && Object.prototype.hasOwnProperty.call(internal, 'expectedInstructorAttendance')
      ? { expectedInstructorAttendance: internal.expectedInstructorAttendance }
      : {};
    return this.update(id, {
      acknowledgeAccountingImpact: input.acknowledgeAccountingImpact,
      expectedAccountingImpactHash: input.expectedAccountingImpactHash,
    } as UpdateScheduleDto, actorId, {
      actorCapabilities,
      auditReason: internal?.auditReason ?? '강사 출결 기록/수정',
      ...expectedAttendance,
      instructorAttendanceCommand: { kind: 'set', status: input.status },
    });
  }

  async clearInstructorAttendance(
    id: number,
    input: ClearInstructorAttendanceInput,
    actorId?: number,
    actorCapabilities: RoleCapability[] = [],
  ): Promise<ScheduleMutationResult> {
    await this.read.ensureReady();
    if (!actorCapabilities.includes('session-attendance.manage')) {
      throw new ForbiddenException('강사 출결 변경은 수업 출결 관리 권한이 필요합니다.');
    }
    const session = this.db.findById<ClassSession>(SESSIONS, id);
    if (!session) throw new NotFoundException(`Session ${id} not found`);
    if (session.instructorId == null) throw new ConflictException('배정중 수업에는 초기화할 강사 출결이 없습니다.');
    return this.update(id, {
      acknowledgeAccountingImpact: input.acknowledgeAccountingImpact,
      expectedAccountingImpactHash: input.expectedAccountingImpactHash,
    } as UpdateScheduleDto, actorId, {
      actorCapabilities,
      auditReason: input.reason,
      instructorAttendanceCommand: { kind: 'clear' },
    });
  }

  async update(
    id: number,
    dto: UpdateScheduleDto,
    actorId?: number,
    // [74D-0] 승인 경로 전용 — 요청 생성 시 snapshot한 대상 집합과 잠금 후 실제 대상을 결속(drift=전체 rollback).
    internalOpts?: {
      expectedTargetIds?: readonly number[];
      actorCapabilities?: RoleCapability[];
      auditReason?: string;
      expectedInstructorAttendance?: ClassSession['instructorAttendance'] | null;
      instructorAttendanceCommand?:
        | { kind: 'set'; status: NonNullable<ClassSession['instructorAttendance']> }
        | { kind: 'clear' };
    },
  ): Promise<ScheduleMutationResult> {
    await this.read.ensureReady();
    // [원자성] 반복 시리즈 scope 편집 — 대상+동반 세션이 전부 반영되거나 전부 롤백(부분 편집 잔존 금지)
    // [TBO-28C] 사전 조회는 잠금 키 산정용 — 잠금 후 권위 재조회로 다시 읽는다.
    const pre = this.db.findById<ClassSession>(SESSIONS, id);
    if (!pre) throw new NotFoundException(`Session ${id} not found`);
    return this.unitOfWork.run(async () => {
    // series를 먼저 단독 잠근 뒤 전체 member/resource/session 키를 한 번에 획득한다.
    // 같은 series의 서로 다른 회차에서 scope 편집해도 낮은 kind 락을 뒤늦게 얻는 역전이 없다.
    if (pre.seriesId != null) {
      await this.unitOfWork.lockTargets([{ kind: 'series', id: Number(pre.seriesId) }]);
    }
    await this.refreshAfterLock();
    const scopedPre = this.db.findById<ClassSession>(SESSIONS, id);
    if (!scopedPre) throw new NotFoundException(`Session ${id} not found`);
    const requestedScope = (dto.scope ?? 'this') as SeriesScope;
    const preliminaryMembers = requestedScope !== 'this' && scopedPre.seriesId != null
      ? selectSeriesScope(
        this.db.findBy<ClassSession>(SESSIONS, (session) => session.seriesId === scopedPre.seriesId),
        scopedPre,
        requestedScope,
      )
      : [];
    const preliminaryTargets = [scopedPre, ...preliminaryMembers];
    await this.unitOfWork.lockTargets([
      ...this.calendarLockKeys({
        instructorIds: [...preliminaryTargets.map((session) => session.instructorId), dto.instructorId],
        roomIds: [...preliminaryTargets.map((session) => session.roomId), dto.roomId],
        studentIds: [...new Set([
          ...preliminaryTargets.flatMap((session) => session.studentIds ?? []),
          ...(dto.studentIds ?? []),
        ])],
        sessionIds: [],
      }),
      ...preliminaryTargets
        .filter((session) => session.instructorId != null)
        .map((session) => ({ kind: 'user' as const, id: session.instructorId! })),
      ...(dto.instructorId == null ? [] : [{ kind: 'user' as const, id: dto.instructorId }]),
      ...preliminaryTargets.map((session) => ({ kind: 'course' as const, id: session.courseId })),
      ...(dto.courseId == null ? [] : [{ kind: 'course' as const, id: dto.courseId }]),
      ...sessionAccountingLockKeys({ sessionIds: preliminaryTargets.map((session) => session.id) }),
    ]);
    await this.refreshAfterLock();
    await this.courses.refreshAccountingRatesFresh();
    const cur = this.db.findById<ClassSession>(SESSIONS, id);
    if (!cur) throw new NotFoundException(`Session ${id} not found`);
    this.assertCompletionStatusCommand(cur.status, dto.status);
    const instructorAttendanceCommand = internalOpts?.instructorAttendanceCommand;
    if (instructorAttendanceCommand && !internalOpts?.actorCapabilities?.includes('session-attendance.manage')) {
      throw new ForbiddenException('강사 출결 변경은 수업 출결 관리 권한이 필요합니다.');
    }
    if (
      instructorAttendanceCommand
      && internalOpts != null
      && Object.prototype.hasOwnProperty.call(internalOpts, 'expectedInstructorAttendance')
      && (cur.instructorAttendance ?? null) !== internalOpts?.expectedInstructorAttendance
    ) {
      throw new ConflictException({
        code: 'REQUEST_TARGET_STALE',
        message: '요청 이후 강사 출결이 변경되었습니다. 최신 출결을 확인한 새 요청이 필요합니다.',
        expectedInstructorAttendance: internalOpts?.expectedInstructorAttendance ?? null,
        currentInstructorAttendance: cur.instructorAttendance ?? null,
      });
    }
    // 참조 무결성(FK) 검증
    if (dto.courseId != null && !this.read.courseOf(dto.courseId)) throw new BadRequestException(`courseId ${dto.courseId} 없음`);
    if (dto.instructorId != null && !this.read.isScheduleOwner(dto.instructorId)) throw new BadRequestException(`instructorId ${dto.instructorId}는 활성 강사 또는 대표가 아닙니다`);
    if (dto.roomId != null && !this.rooms.findAll().some((r) => r.id === dto.roomId)) throw new BadRequestException(`roomId ${dto.roomId} 없음`);

    // [TBO-29C C3] series 권위 확인 + version CAS — 잠금 후 판정이 권위. stale 클라이언트 명령은 409.
    const seriesRow = cur.seriesId != null ? this.db.findById<ScheduleSeriesRow>(CLASS_SESSION_SERIES, cur.seriesId) : undefined;
    if (dto.expectedSeriesVersion != null && seriesRow && dto.expectedSeriesVersion !== seriesRow.version) {
      throw new ConflictException({
        code: 'SERIES_VERSION_STALE',
        message: `시리즈가 다른 변경으로 갱신됐습니다(현재 v${seriesRow.version}). 새로고침 후 다시 시도하세요.`,
        currentVersion: seriesRow.version,
      });
    }

    // 1) 대상(primary) 세션의 새 필드 계산
    const primary = this.mergeFields(cur, dto);
    this.read.validateSessionStudentIds(primary.studentIds);
    if (instructorAttendanceCommand?.kind === 'set') {
      primary.instructorAttendance = instructorAttendanceCommand.status;
    } else if (instructorAttendanceCommand?.kind === 'clear') {
      primary.instructorAttendance = null;
    }
    if (instructorAttendanceCommand?.kind === 'clear' && cur.status === 'held') {
      primary.status = 'scheduled';
    }

    // 2) 시리즈 동반 편집 대상 산출(this=대상만, this_and_following=대상 이후, all=시리즈 전체)
    //    [TBO-29C C3] 대상 집합은 selectSeriesScope 순수 함수(같은 날짜의 늦은 회차도 시간·id로 판정).
    //    공통 델타: 날짜(일수)·시작시각(분). 강의실/강사/상태/시수는 절대값으로 동일 적용.
    const scope = requestedScope;
    const dayDelta = dayDiff(primary.sessionDate, cur.sessionDate);
    const startDelta = toMin(primary.startTime) - toMin(cur.startTime ?? primary.startTime);
    let scopeMembers: ClassSession[] = [];
    if (scope !== 'this' && cur.seriesId != null) {
      scopeMembers = selectSeriesScope(this.db.findBy<ClassSession>(SESSIONS, (s) => s.seriesId === cur.seriesId), cur, scope);
    }
    const seriesPatches: { id: number; before: ClassSession; fields: MergedFields }[] = [];
    for (const m of scopeMembers) {
      const mStart = addMinutes(m.startTime ?? '00:00', startDelta);
      seriesPatches.push({
        id: m.id,
        before: { ...m }, // [C3] 회차별 audit before 스냅샷(잠금 후 권위 상태)
        fields: {
          sessionDate: addDaysISO(m.sessionDate, dayDelta),
          startTime: mStart,
          endTime: endTimeOf(mStart, primary.durationMinutes), // [R-9] 크로스면 undefined(파생 저장)
          durationMinutes: primary.durationMinutes,
          courseId: primary.courseId,
          instructorId: primary.instructorId,
          roomId: primary.roomId,
          status: primary.status,
          topic: m.topic ?? primary.topic,
        },
      });
    }
    // [74D-0] 승인 경로: 요청 생성 시점 대상 snapshot과 잠금 후 실제 대상 대조 — 달라졌으면 전체 rollback(삭제와 동일).
    if (internalOpts?.expectedTargetIds) {
      const expectedTargetIds = [...internalOpts.expectedTargetIds].sort((a, b) => a - b);
      const currentTargetIds = [cur.id, ...seriesPatches.map((patch) => patch.id)].sort((a, b) => a - b);
      if (
        expectedTargetIds.length !== currentTargetIds.length
        || expectedTargetIds.some((targetId, index) => targetId !== currentTargetIds[index])
      ) {
        throw new ConflictException({
          code: 'REQUEST_SCOPE_STALE',
          message: '요청 이후 반복 수업 대상이 변경되었습니다. 현재 범위를 확인한 새 요청이 필요합니다.',
          expectedTargetIds,
          currentTargetIds,
        });
      }
    }
    const accountingContext = await this.accountingContext.loadFresh([
      cur.id,
      ...seriesPatches.map((patch) => patch.id),
    ]);
    const temporalChangedIds: number[] = [];
    const applyTemporalPolicy = (before: ClassSession, fields: MergedFields): void => {
      if (!hasSessionTemporalChange(before, fields)) return;
      if (isTemporalChangeBlockedStatus(before.status)) {
        throw new ConflictException({
          code: 'TERMINAL_SESSION_TIME_CHANGE',
          message: `종결 상태(${before.status}) 수업의 시간은 변경할 수 없습니다.`,
          sessionId: before.id,
        });
      }
      if (dto.status != null || instructorAttendanceCommand) {
        throw new BadRequestException('시간 변경과 상태/강사 출결 변경은 한 요청에 함께 보낼 수 없습니다.');
      }
      fields.status = 'scheduled';
      fields.instructorAttendance = null;
      temporalChangedIds.push(before.id);
    };
    applyTemporalPolicy(cur, primary);
    for (const patch of seriesPatches) applyTemporalPolicy(patch.before, patch.fields);

    // 강사 출결만 기록하는 명령은 학생 전원의 출결까지 채워졌을 때만 held로 전이한다.
    // 학생 출결 명령은 AttendanceService가 같은 정책을 사용한다.
    if (!temporalChangedIds.length && dto.status == null && instructorAttendanceCommand?.kind === 'set') {
      const holdPatch = attendanceCompletionHoldPatch(
        { ...cur, ...primary, id: cur.id },
        accountingContext.cohortIndex,
        this.accountingContext.attendanceFor(accountingContext, cur.id),
        Date.now(),
      );
      if (holdPatch) {
        primary.status = holdPatch.status;
        // [TBO-79 D1] held 전이 = 참가자 확정 시점. status만 받으면 명시 코호트가 비어 있는
        //  세션이 이후에도 살아있는 활성 수강으로 재해석돼 과거가 소급 변경된다.
        if (holdPatch.studentIds) primary.studentIds = holdPatch.studentIds;
      }
    }
    this.accountingContext.assertDependentsCompatible(accountingContext, cur, primary);
    // [TBO-79 B1] before/after 모두 정산서 라인 산정과 같은 분류 입력으로 투영한다.
    //  종전엔 approvedReport 하나만 넘겨 지각·학생 출결 미기록·책정가가 미리보기에서 사라졌다.
    const pricingInput = (
      sessionId: number,
      shape: Pick<ClassSession, 'courseId' | 'studentIds'>,
    ) => this.accountingContext.pricingInputFor(
      accountingContext,
      sessionId,
      shape,
      this.read.courseOf(shape.courseId)?.hourlyRate,
    );
    const primaryImpact = accountingImpactOf(cur, primary, {
      before: pricingInput(cur.id, cur),
      after: pricingInput(cur.id, primary),
    });
    const accountingImpacts: SessionAccountingImpact[] = [primaryImpact];
    const accountingLocked: ClassSession[] = isPayoutLocked(cur) ? [cur] : [];
    for (const patch of seriesPatches) {
      const member = patch.before;
      if (isPayoutLocked(member)) accountingLocked.push(member);
      this.accountingContext.assertDependentsCompatible(accountingContext, member, patch.fields);
      accountingImpacts.push(accountingImpactOf(member, patch.fields, {
        before: pricingInput(member.id, member),
        after: pricingInput(member.id, { ...member, ...patch.fields }),
      }));
    }
    const impact = combineAccountingImpacts(accountingImpacts);
    // [74D-0] update도 삭제와 같은 영향 지문 — 사용자가 본 미리보기와 잠금 후 실행 대상·영향을 결속.
    const impactHash = accountingImpactHash([cur.id, ...seriesPatches.map((patch) => patch.id)], impact);
    const requiresAccountingAck = impact.changed && ([cur, ...seriesPatches.map((patch) => patch.before)]
      .some((session) => session?.status === 'held' || (session ? isPayoutLocked(session) : false)));
    if (accountingLocked.length) {
      throw new ConflictException({
        code: 'PAYOUT_REVERSAL_REQUIRED',
        message: `정산서에 연결된 수업(${accountingLocked.map((session) => session.id).join(', ')})은 정산 회수 또는 보정 거래 후 변경할 수 있습니다.`,
        impact,
        impactHash,
      });
    }
    // [74D-0] force(충돌 강행)·ack(회계 확인)·정산 잠금은 독립 옵션 — ack는 hash 일치까지 요구(stale 확인 차단).
    if (requiresAccountingAck && (
      !dto.acknowledgeAccountingImpact
      || dto.expectedAccountingImpactHash !== impactHash
    )) {
      throw new ConflictException({
        code: 'ACCOUNTING_IMPACT_ACK_REQUIRED',
        message: dto.acknowledgeAccountingImpact
          ? '확인한 회계 영향이 현재 상태와 달라졌습니다. 최신 영향 미리보기를 다시 확인하세요.'
          : '완료 수업 변경으로 시수 또는 정산 예상액이 달라집니다. 변경 결과를 확인해 주세요.',
        impact,
        impactHash,
      });
    }

    // 3) 충돌 검사(대상 + 시리즈 동반). 자기 자신과 함께 이동하는 형제는 검사에서 제외.
    const movingIds = new Set<number>([id, ...seriesPatches.map((p) => p.id)]);
    const others = this.db.findBy<ClassSession>(SESSIONS, (s) => !movingIds.has(s.id));
    const blocks = this.availability.list();
    const conflicts: Conflict[] = [];
    // 출결 command는 일정의 시간·자원을 바꾸지 않는다. 기존 시드/운영 데이터에 과거 충돌이 있더라도
    // 사실 기록 자체를 막으면 출결·시수 상태가 영원히 미완결로 남으므로 일정 충돌 검사를 재실행하지 않는다.
    if (!instructorAttendanceCommand) {
      for (const f of [primary, ...seriesPatches.map((p) => p.fields)]) {
        conflicts.push(...detectConflicts(
          // [R-9→C4] 크로스 세션은 endTime이 null(명시) — durationMinutes로 이틀(±1일) 겹침 검사
          { sessionDate: f.sessionDate, startTime: f.startTime, endTime: f.endTime ?? undefined, durationMinutes: f.durationMinutes, instructorId: f.instructorId ?? undefined, roomId: f.roomId, studentIds: f.studentIds ?? this.read.activeStudentIds(f.courseId), mode: f.mode },
          others, blocks,
          this.read.effectiveStudentIds,
          (roomId) => this.rooms.capacityOf(roomId), // [B4] 정원 강제 // [TBO-28C] 학생 세션 간 중복 포함
        ));
      }
    }
    // 결강·취소(canceled/no_show)로 바꾸는 변경은 시간 점유가 사라지므로 충돌 검사와 무관 — 항상 허용.
    const becomesCanceled = primary.status === 'canceled' || primary.status === 'no_show';
    if (conflicts.length && !canForceScheduleConflicts(dto.force) && !becomesCanceled) {
      this.logger.warn(`update 충돌 ${conflicts.length}건 — session=${id} scope=${scope}`);
      throw new ConflictException({ message: '스케줄 충돌', conflicts });
    }

    // 4) 일괄 적용(대상 먼저, 그 뒤 시리즈)
    // [TBO-29C C3] 구 구현은 대표 세션 1건만 audit — 이제 바뀐 **모든 회차**가 개별 before/after를 남기고
    //  공통 correlation(reason: series=<id> scope=<scope> corr=<uuid>)으로 한 명령임을 추적한다.
    const commandCorrelation = randomUUID();
    const correlation = internalOpts?.auditReason ?? (cur.seriesId != null
      ? `series=${cur.seriesId} scope=${scope} corr=${commandCorrelation}`
      : temporalChangedIds.length
        ? `${TEMPORAL_RESET_AUDIT_REASON} corr=${commandCorrelation}`
        : undefined);
    const beforeSnap = { ...cur }; // audit diff용(적용 전 상태 — cur는 라이브 행이라 사본 필수)
    const updated = (await this.sessions.update(id, primary as never))!;
    const memberAfters: Array<{ before: ClassSession; after: ClassSession | undefined }> = [];
    for (const p of seriesPatches) {
      const after = await this.sessions.update(p.id, p.fields as never);
      memberAfters.push({ before: p.before, after });
    }
    for (const sessionId of temporalChangedIds) {
      await this.attendance.removeBySession(sessionId, actorId, correlation);
    }
    if (actorId != null) {
      const diff = this.audit.diffOf(beforeSnap, updated) as Record<string, { before?: unknown; after?: unknown }>;
      // [74D-0] 확인 지문을 감사에 영속 — "무엇을 보고 승인했는가"가 재구성된다(삭제와 동일 규약).
      if (requiresAccountingAck) {
        diff.accountingImpactAcknowledgement = {
          before: null,
          after: { hash: impactHash, impact },
        };
      }
      if (Object.keys(diff).length)
        await this.audit.log({ entity: SESSIONS, entityId: id, action: 'update', actorId, changes: diff, reason: correlation });
      for (const { before, after } of memberAfters) {
        if (!after) continue;
        const mdiff = this.audit.diffOf(before, after);
        if (Object.keys(mdiff).length)
          await this.audit.log({ entity: SESSIONS, entityId: after.id, action: 'update', actorId, changes: mdiff, reason: correlation });
      }
    }
    // [C3] scope 편집이 시리즈에 반영되면 version CAS 전진(+audit) — 이후 stale 클라이언트는 409.
    if (seriesRow && scope !== 'this') {
      const beforeSeries = { ...seriesRow };
      const bumped = await this.collections.update<ScheduleSeriesRow>(CLASS_SESSION_SERIES_SPEC, seriesRow.id, {
        version: seriesRow.version + 1, updatedBy: actorId ?? null,
      } as Partial<Omit<ScheduleSeriesRow, keyof BaseRow>>);
      if (actorId != null && bumped) {
        await this.audit.log({ entity: CLASS_SESSION_SERIES, entityId: seriesRow.id, action: 'update', actorId, changes: this.audit.diffOf(beforeSeries, bumped) as never, reason: correlation });
      }
    }

    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return {
      row: this.read.enrich(updated, roomsMap), conflicts, updated: 1 + seriesPatches.length,
      // [74D-0] 적용된 영향·지문을 응답에도 — 승인 감사(요청 경로)와 FE 표시가 같은 값을 재사용.
      accountingImpact: impact.changed ? impact : undefined,
      accountingImpactHash: impact.changed ? impactHash : undefined,
    };
      });
  }

  // 부분수정 DTO → 세션 전체 필드(이동=날짜/시간, 리사이즈=종료/시수, 편집=코스/강사/강의실/상태).
  private mergeFields(cur: ClassSession, dto: UpdateScheduleDto): MergedFields {
    const sessionDate = dto.sessionDate ?? cur.sessionDate;
    const startTime = dto.startTime ?? cur.startTime ?? '00:00';
    // [R-9 2026-07-06] 자정 크로스 정식 지원 — (구 [R-1b F4] 400 차단 규칙 대체):
    //  · dto.endTime 경로: endTime<startTime = 익일 종료(+1440 래핑, 예: 23:00→01:00=120분).
    //  · durationMinutes 경로(드래그 이동 = {startTime, durationMinutes} 패치): 자정 초과 허용.
    //  어느 경로든 종료가 24:00 이상이면 endTime을 저장하지 않고(undefined) durationMinutes로 파생 —
    //  '25:00' 같은 무효 HH:mm이 DB에 남지 않는다. 크로스 상한 480분(assertDuration).
    // [C4] 시간 정규화 단일 진입점 — 종료/시수 미지정 = 기존 시수 유지(defaultDurationMinutes).
    //  크로스 endTime은 명시 null(UPDATE에서 이전 end_time 잔존 차단 — C0 기준선 발견 ①② 해소).
    const { durationMinutes, endTime } = normalizeSessionTime(
      { startTime, endTime: dto.endTime, durationMinutes: dto.durationMinutes },
      { defaultDurationMinutes: cur.durationMinutes });

    const courseId = dto.courseId ?? cur.courseId;
    const course = this.read.courseOf(courseId);
    const instructorId = dto.instructorId ?? (dto.courseId != null && course ? course.instructorId : cur.instructorId);
    const roomId = dto.roomId ?? cur.roomId;
    return {
      sessionDate, startTime, endTime, durationMinutes, courseId, instructorId, roomId,
      status: dto.status ?? cur.status,
      topic: dto.topic ?? (dto.courseId != null && course ? course.name : cur.topic),
      memo: dto.memo ?? cur.memo,
      color: dto.color ?? cur.color,
      instructorAttendance: cur.instructorAttendance,
      studentIds: dto.studentIds ?? cur.studentIds, // 명시 코호트(v0.1.13) — 검증은 update() 본문
      // [R-6 audit 노이즈 정리 2026-07-07] merge는 **보존만**(기본값 채우기 제거) — 기본값은 create()·enrich()가 담당.
      //  종전 `?? SESSION_DEFAULTS`는 구/시드 세션(kind·mode 미저장)을 부분 PATCH할 때 undefined→기본값을
      //  audit diff가 "변경"으로 잡아 이력이 지저분했음. 보존으로 바꿔 미변경 필드는 diff에 안 남음(읽기 기본값=enrich).
      kind: dto.kind ?? cur.kind, // [v0.1.14] 미저장이면 undefined 유지(enrich가 read-time에 class 채움)
      mode: dto.mode ?? cur.mode, // [v0.1.16] 미저장이면 undefined 유지(enrich가 read-time에 in_person 채움)
      isPublic: dto.isPublic ?? cur.isPublic,
      price: dto.price ?? cur.price,
    };
  }

}
