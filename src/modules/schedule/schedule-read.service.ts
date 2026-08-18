// [TBO-69 C1 2026-07-26] 스케줄 **읽기(Query) 서비스** — schedule.service(1,147줄)에서 분리.
//  소유: 읽기 hydrate 게이트(EP2 TTL)·카탈로그/명단 lookup·enrich 읽기모델·목록/단건/집계/리소스·
//  충돌 드라이런·세션 입력 검증(생성·요청 공용). **본문 이동만 — 규약 무변**(주석·산식·경계 그대로).
//  명령(schedule.service)은 이 서비스를 단방향 주입해 ensureReady/lookup/enrich를 경유한다(순환 없음).
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Conflict, ScheduleQuery, ScheduleRow } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { RoomsService } from '../rooms/rooms.service';
import { AvailabilityService } from '../availability/availability.service';
import { ClassSession, SESSIONS } from './schedule.entity';
import { detectConflicts } from './conflict.util';
import { Course, COURSES as COURSES_COL } from '../courses/course.entity';
import { CoursesService } from '../courses/courses.service';
import { Subject, SUBJECTS as SUBJECTS_COL } from '../subjects/subject.entity';
import { Student, STUDENTS as STUDENTS_COL } from '../students/student.entity';
import { isScheduleVisibleStudentStatus } from '../students/student-status.policy';
import { studentGradeLabel } from '../students/student-grade.policy';
import { Enrollment, ENROLLMENTS as ENROLLMENTS_COL } from '../enrollments/enrollment.entity';
import { USERS, isActiveScheduleOwner, isTeachingAccount, type StaffAccount } from '../users/user.entity';
import { INSTRUCTOR_PROFILES, activeTeachingProfileUserIds, type InstructorProfile } from '../users/instructor-profiles.store';
import { ClassSessionsStore } from './class-sessions.store';
import { CLASS_SESSION_SERIES, type ScheduleSeriesRow } from './schedule-series.entity';
import { storedEndTimeOf, SESSION_TIME_DEFAULTS } from './session-time.policy';
import { CalendarUnitOfWork } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { ATTENDANCE_SPEC, CLASS_SESSION_SERIES_SPEC, COURSES_SPEC, ENROLLMENTS_SPEC, STUDENTS_SPEC, SUBJECTS_SPEC, USERS_SPEC, ROOMS_SPEC } from '../../database/calendar-asset-specs';
import { countsForTeachingHours, teachingMinutesOf } from './session-accounting.policy';
import { isSessionVisibleToInstructor } from './schedule-visibility.policy';
import { weekdayOf } from '../../common/time.util';
import type { Room } from '../rooms/room.entity';
import { Attendance, ATTENDANCE } from '../attendance/attendance.entity';
import { attendanceRequirementOf } from './session-temporal-transition.policy';
import { buildCohortIndex } from './session-participant.policy';
import { measurePerformance, TimedModuleInit } from '../../common/performance-timing';

// 과목 색 폴백(표시용) — Subject 계약에 color가 없어 세션→코스 색이 모두 없을 때만 사용.
const SUBJECT_FALLBACK_COLOR: Record<number, string> = { 1: '#0969da', 2: '#1a7f37' };

// [R-3 2차] 세션 필드 기본값 단일 소스 — create·mergeFields·enrich가 공유(리터럴 중복 제거·단일 책임).
//  하위호환 폴백값(구데이터·미지정 입력)을 한 곳에서 관리 → 필드 추가 시 여기만 갱신.
//  [TBO-69 C1] 읽기 서비스가 export — 명령(schedule.service)이 import(사본 금지).
export const SESSION_DEFAULTS = {
  kind: 'class',
  mode: 'in_person',
  status: 'scheduled',
  durationMinutes: SESSION_TIME_DEFAULTS.durationMinutes, // [C4] 시간 기본값은 session-time.policy가 소유
} as const satisfies { kind: ClassSession['kind']; mode: ClassSession['mode']; status: ClassSession['status']; durationMinutes: number };

// [TBO-29C C4] 자정 크로스 endTime 규약은 session-time.policy 단일 소스(storedEndTimeOf 별칭).
const endTimeOf = storedEndTimeOf;

@TimedModuleInit()
@Injectable()
export class ScheduleReadService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleReadService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly sessions: ClassSessionsStore,
    private readonly unitOfWork: CalendarUnitOfWork,
    private readonly rooms: RoomsService,
    private readonly availability: AvailabilityService,
    private readonly collections: PostgresCollectionStore,
    private readonly courses: CoursesService,
  ) {}

  // 이번 주 데모 수업 시드 — 주간 반복 시리즈 단위(같은 시리즈=한 seriesId). 충돌 없게 구성.
  async onModuleInit(): Promise<void> {
    await this.sessions.ensureReady();
  }

  // [EP2 2026-07-16] 읽기 경로 hydrate 게이트 — 종전엔 캘린더 진입 시 읽기 라우트 **각각**이
  //  일정 read model(class_sessions·availability·users·series·courses·subjects·enrollments·students)을
  //  PostgreSQL에서 재적재한다. 서버리스의 다른 인스턴스가 과목/학생/수강을 만든 직후에도
  //  캘린더와 수업 목록이 인스턴스 로컬 메모리를 권위로 오인하지 않게 하는 SSOT 경계다.
  //  ① in-flight 공유: 동시 읽기(캘린더 병렬 요청 버스트)는 진행 중인 hydrate 1회를 공유.
  //  ② TTL: 직전 hydrate가 TTL 이내면 스킵(교차 인스턴스 staleness ≤ TTL — 같은 인스턴스의
  //     쓰기는 write-through로 메모리에 즉시 반영되므로 read-after-write는 영향 없음).
  //  안전 경계: pg tx 안(refreshAfterLock — 명령의 권위 재조회)은 게이트 비대상(항상 전량, 순차).
  //  기본 TTL: test=0(교차 인스턴스 즉시 가시성 시맨틱 보존 — TBO-28F e2e), 그 외 2000ms.
  //  env SCHEDULE_READ_HYDRATE_TTL_MS로 재정의(0=끔).
  private hydratedAt = 0;
  private hydrateInFlight: Promise<void> | null = null;
  private readonly hydrateTtlMs = process.env.SCHEDULE_READ_HYDRATE_TTL_MS != null
    ? Math.max(0, Number(process.env.SCHEDULE_READ_HYDRATE_TTL_MS) || 0)
    : process.env.NODE_ENV === 'test' ? 0 : 2000;

  async ensureReady(): Promise<void> {
    return measurePerformance('calendar.readModelHydrate', async () => {
      // [TBO-28F] users도 재조회 — 다른 인스턴스에서 승인/등록된 계정이 리소스·검증에 즉시 반영.
      // [TBO-29C C2→C5 성능 수정] pg tx **안**(refreshAfterLock)에서는 단일 커넥션이라 순차 실행,
      //  tx **밖**(일반 조회 경로)에서는 병렬 — 순차 고정이 Neon(WAN) 왕복 지연을 합산시켜
      //  release 게이트 db-crud가 타임아웃하는 회귀를 만들었다(실측 2026-07-15).
      const tasks = [
        () => this.sessions.ensureReady(),
        () => this.availability.refresh(),
        () => this.collections.hydrate<StaffAccount>(USERS_SPEC),
        () => this.collections.hydrate<ScheduleSeriesRow>(CLASS_SESSION_SERIES_SPEC),
        () => this.collections.hydrate<Course>(COURSES_SPEC),
        () => this.collections.hydrate<Subject>(SUBJECTS_SPEC),
        () => this.collections.hydrate<Enrollment>(ENROLLMENTS_SPEC),
        () => this.collections.hydrate<Student>(STUDENTS_SPEC),
        () => this.collections.hydrate<Room>(ROOMS_SPEC), // [TBO-66 R2] roomId 검증·정원 충돌·이름 표기가 메모리 미러 소비 — 교차 인스턴스 신선화
        () => this.collections.hydrate<Attendance>(ATTENDANCE_SPEC),
      ];
      if (this.unitOfWork.inPgTransaction) {
        for (const task of tasks) await task();
        this.hydratedAt = Date.now();
        return;
      }
      if (this.hydrateTtlMs > 0 && Date.now() - this.hydratedAt < this.hydrateTtlMs) return;
      if (this.hydrateInFlight) return this.hydrateInFlight;
      this.hydrateInFlight = Promise.all(tasks.map((task) => task()))
        .then(() => { this.hydratedAt = Date.now(); })
        .finally(() => { this.hydrateInFlight = null; });
      return this.hydrateInFlight;
    }, undefined, this.logger);
  }

  /** 명시 참가자 우선. 빈 값의 코스 roster fallback은 과거 세션 호환 전용이다. */
  effectiveStudentIds = (s: ClassSession): number[] =>
    s.studentIds?.length ? s.studentIds : this.activeStudentIds(s.courseId);

  // ── 카탈로그/명단 조회(단일 소스 = 실제 컬렉션) — 감사 A ──
  courseOf(id: number): Course | undefined {
    return this.courses.findOptional(id);
  }
  subjectOf(id?: number): Subject | undefined {
    return id == null ? undefined : this.db.findById<Subject>(SUBJECTS_COL, id);
  }
  studentOf(id: number): Student | undefined {
    return this.db.findById<Student>(STUDENTS_COL, id);
  }
  // [강사 식별자 통일] 강사 = users(role='instructor'), 강사 id = users.id.
  // [TBO-28B→TBO-87] 중앙 술어 = isTeachingAccount(겸직 포함) ∨ 대표(owner) —
  //  pending/rejected 노출 차단 유지 + manager/admin 겸직(활성 강사원부)이 자동 포함된다.
  private teachingProfileIds(): Set<number> {
    return activeTeachingProfileUserIds(this.db.findAll<InstructorProfile>(INSTRUCTOR_PROFILES));
  }
  scheduleOwnerUsers(): StaffAccount[] {
    const teaching = this.teachingProfileIds();
    return this.db.findBy<StaffAccount>(USERS, (u) => isActiveScheduleOwner(u, teaching));
  }
  instructorName(id?: number | null): string | undefined {
    return id == null ? undefined : this.db.findById<StaffAccount>(USERS, id)?.englishName;
  }
  isScheduleOwner(id: number): boolean {
    return isActiveScheduleOwner(this.db.findById<StaffAccount>(USERS, id), this.teachingProfileIds());
  }
  // 코호트 = 활성 수강(enrollment.status==='active') ∧ 캘린더 노출 상태 학생.
  //  students.remove(소프트삭제)가 학생·수강 모두 'canceled'로 정리하므로 삭제 즉시 코호트에서 빠진다.
  activeStudentIds(courseId: number): number[] {
    // 인덱스 조회(courseId) — enrich가 세션마다 호출하는 핫패스(전체 스캔 제거)
    // [TBO-80 80C] 활성 필터는 정책(buildCohortIndex) 위임 — 인라인 사본 금지(FC-1 부류).
    return [...(buildCohortIndex(this.db.findByField<Enrollment>(ENROLLMENTS_COL, 'courseId', courseId)).get(courseId) ?? [])]
      .filter((sid) => {
        const student = this.studentOf(sid);
        return student != null && isScheduleVisibleStudentStatus(student.status);
      });
  }

  // [B7 E3 2026-07-16] 단건 조회 — list와 동일 enrich(발행된 ScheduleRow 계약 재사용, 계약 무변경).
  //  없는 id=404. 강사 스코프(존재하나 본인 세션 아님=403)는 컨트롤러가 판정(404→403 표준 — B7 문서 §1b).
  findOneEnriched(id: number): ScheduleRow {
    const row = this.db.findById<ClassSession>(SESSIONS, id);
    if (!row) throw new NotFoundException(`Session ${id} not found`);
    const rooms = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return this.enrich(row, rooms);
  }

  // 기간/필터 조회 → enriched 읽기모델(주간 표/캘린더용)
  // studentId 필터는 세션 참가자 snapshot 기준이다. enrollment는 장기 수강 관계일 뿐 일정 참가 여부가 아니다.
  list(opts: ScheduleQuery): ScheduleRow[] {
    const rooms = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    // [EP3 2026-07-16] 인덱스 진입 — instructorId(강사 캘린더 핫패스)·roomId 지정 시 세컨더리
    //  인덱스(findByField)로 후보를 좁힌 뒤 잔여 필터. 종전엔 인덱스가 있는데도 findBy 전량 스캔.
    const base = opts.instructorId
      ? this.db.findByField<ClassSession>(SESSIONS, 'instructorId', opts.instructorId)
      : opts.roomId
        ? this.db.findByField<ClassSession>(SESSIONS, 'roomId', opts.roomId)
        : this.db.findAll<ClassSession>(SESSIONS);
    return base
      .filter((s) =>
        (opts.from ? s.sessionDate >= opts.from : true) &&
        (opts.to ? s.sessionDate <= opts.to : true) &&
        (opts.instructorId ? s.instructorId === opts.instructorId : true) &&
        (opts.roomId ? s.roomId === opts.roomId : true) &&
        (opts.assignment === 'assigned' ? s.instructorId != null : true) &&
        (opts.assignment === 'unassigned' ? s.instructorId == null : true) &&
        (opts.studentId != null ? this.effectiveStudentIds(s).includes(Number(opts.studentId)) : true),
      )
      .map((s) => this.enrich(s, rooms))
      .sort((a, b) => (a.sessionDate + (a.startTime ?? '')).localeCompare(b.sessionDate + (b.startTime ?? '')));
  }

  listVisible(
    opts: ScheduleQuery,
    viewerInstructorId: number,
  ): ScheduleRow[] {
    return this.list(opts).filter((row) => isSessionVisibleToInstructor(row, viewerInstructorId));
  }

  /**
   * HTTP 목록용 DB 권위 Query. 세션 행은 매 요청 PostgreSQL에서 읽고, 사용자·코스·학생·강의실
   * 카탈로그만 ensureReady의 bounded TTL 미러를 사용한다.
   */
  async listFresh(
    opts: ScheduleQuery,
  ): Promise<ScheduleRow[]> {
    await this.ensureReady();
    const rooms = new Map(this.rooms.findAll().map((room) => [room.id, room]));
    const rows = await this.sessions.listDb(opts);
    return rows
      .filter((row) => opts.studentId != null ? this.effectiveStudentIds(row).includes(Number(opts.studentId)) : true)
      .map((row) => this.enrich(row, rooms));
  }

  async listVisibleFresh(
    opts: ScheduleQuery,
    viewerInstructorId: number,
  ): Promise<ScheduleRow[]> {
    const rows = await this.listFresh({ ...opts, instructorId: undefined });
    return rows.filter((row) => isSessionVisibleToInstructor(row, viewerInstructorId));
  }

  listReadMetadata(): { source: 'postgres' | 'in-memory'; catalogHydrateAgeMs: number } {
    return {
      source: this.sessions.durable ? 'postgres' : 'in-memory',
      catalogHydrateAgeMs: this.hydratedAt > 0 ? Math.max(0, Date.now() - this.hydratedAt) : -1,
    };
  }

  // [TBO-19] 강사 출결 현황 집계(관리자 대시보드) — 기간·강사 필터.
  //  · 카운트(출/지/결/보강/미표시)는 **진행 회차(held·makeup)** 기준(마킹 대상).
  //  · 인정 시수는 **시수 정책**(status='held' && 결석 아님 — 보강 제외, payouts와 동일 규칙).
  //  ⚠ DB 이관(TBO-08): 지금은 in-memory 전 세션 스캔+집계 → Postgres에선 **class_sessions GROUP BY instructor_id**
  //    (WHERE date BETWEEN·status IN, deleted_at IS NULL)로 승격. 규칙(카운트 모집단·시수)은 그대로 유지.
  instructorAttendanceSummary(
    opts: { from?: string; to?: string; instructorId?: number },
  ): import('@kms545487/contracts').InstructorAttendanceSummary {
    const teaching = this.teachingProfileIds(); // [TBO-87] 겸직 포함 — 행별 재조회 대신 1회 산출
    const sessions = this.list(opts).filter((r) =>
      (r.status === 'held' || r.status === 'makeup')
      && isTeachingAccount(this.db.findById<StaffAccount>(USERS, Number(r.instructorId)), teaching));
    const byInst = new Map<number, ScheduleRow[]>();
    for (const r of sessions) {
      const k = Number(r.instructorId);
      byInst.set(k, [...(byInst.get(k) ?? []), r]);
    }
    const rows = [...byInst.entries()]
      .map(([instructorId, list]) => {
        const c = { present: 0, late: 0, absent: 0, makeup: 0, unmarked: 0 };
        let teachingMinutes = 0;
        for (const s of list) {
          const a = s.instructorAttendance;
          if (a === 'present' || a === 'late' || a === 'absent' || a === 'makeup') c[a]++;
          else c.unmarked++;
          if (countsForTeachingHours(s)) teachingMinutes += teachingMinutesOf(s);
        }
        const denom = c.present + c.late + c.absent;
        const attendanceRate = denom ? Math.round(((c.present + c.late) / denom) * 100) : null;
        return {
          instructorId, instructorName: list[0]?.instructorName ?? `강사 ${instructorId}`,
          held: list.length, present: c.present, late: c.late, absent: c.absent, makeup: c.makeup, unmarked: c.unmarked,
          attendanceRate, teachingMinutes, teachingHours: Math.round((teachingMinutes / 60) * 100) / 100,
        };
      })
      .sort((a, b) => a.instructorName.localeCompare(b.instructorName, 'ko'));
    const totals = rows.reduce(
      (t, r) => ({
        instructors: t.instructors + 1, held: t.held + r.held, present: t.present + r.present, late: t.late + r.late,
        absent: t.absent + r.absent, makeup: t.makeup + r.makeup, unmarked: t.unmarked + r.unmarked,
        teachingHours: Math.round((t.teachingHours + r.teachingHours) * 100) / 100,
      }),
      { instructors: 0, held: 0, present: 0, late: 0, absent: 0, makeup: 0, unmarked: 0, teachingHours: 0 },
    );
    return { from: opts.from, to: opts.to, rows, totals };
  }

  // 자원 피커(좌측 레일·필터)용 경량 목록 — 강사·강의실·학생.
  resources(scope?: { instructorId?: number }): import('@kms545487/contracts').ScheduleResources {
    const PALETTE = ['#0969da', '#1a7f37', '#8250df', '#bf3989', '#9a6700', '#1b7c83'];
    // 코스 진행시간·활성 roster를 한 번씩 색인한다. 응답 course option이 캘린더 생성/과목 split의
    // 유일한 DB read model이므로 프론트가 /courses·/subjects·/enrollments·/students 전량을 재조회하지 않는다.
    const courseDurationById = new Map<number, number>();
    for (const session of this.db.findAll<ClassSession>(SESSIONS)) {
      if (!courseDurationById.has(Number(session.courseId))) {
        courseDurationById.set(Number(session.courseId), session.durationMinutes);
      }
    }
    const studentIdsByCourse = new Map<number, number[]>();
    for (const enrollment of this.db.findAll<Enrollment>(ENROLLMENTS_COL)) {
      if (enrollment.status !== 'active') continue;
      const student = this.studentOf(enrollment.studentId);
      if (!student || !isScheduleVisibleStudentStatus(student.status)) continue;
      const ids = studentIdsByCourse.get(Number(enrollment.courseId)) ?? [];
      ids.push(Number(enrollment.studentId));
      studentIdsByCourse.set(Number(enrollment.courseId), ids);
    }
    const courses = this.db
      .findAll<Course>(COURSES_COL)
      .filter((c) => scope?.instructorId == null || Number(c.instructorId) === Number(scope.instructorId));
    const scopedStudentIds = scope?.instructorId == null
      ? null
      : new Set(courses.flatMap((course) => studentIdsByCourse.get(Number(course.id)) ?? []));
    return {
      instructors: this.scheduleOwnerUsers().filter((u) => scope?.instructorId == null || Number(u.id) === Number(scope.instructorId)).map((u) => {
        const c = courses.find((x) => x.instructorId === u.id);
        return {
          type: 'instructor' as const, id: u.id, name: u.englishName,
          color: PALETTE[u.id % PALETTE.length],
          sub: c ? this.subjectOf(c.subjectId)?.name : undefined,
          countryCode: u.countryCode ?? undefined,
          timeZone: u.timeZone ?? undefined,
          scheduleOwnerRole: u.role,
        };
      }),
      rooms: this.rooms.findAll().map((r) => ({
        type: 'room' as const, id: r.id, name: r.name, color: r.color,
        sub: r.capacity != null ? `정원 ${r.capacity}` : undefined,
      })),
      // 학생 = students 컬렉션(단일 소스). 중앙 상태 술어로 캘린더 노출 대상을 제한한다.
      students: this.db
        .findBy<Student>(STUDENTS_COL, (s) => isScheduleVisibleStudentStatus(s.status) && (scopedStudentIds == null || scopedStudentIds.has(Number(s.id))))
        .map((s) => ({
          type: 'student' as const, id: s.id, name: s.name,
          color: PALETTE[(s.id + 2) % PALETTE.length],
          sub: studentGradeLabel(s.grade),
          countryCode: s.country,
        })),
      courses: courses.map((c) => ({
        id: c.id, name: c.name, subjectId: c.subjectId, instructorId: c.instructorId,
        instructorName: c.instructorId == null ? null : this.instructorName(c.instructorId) ?? null,
        subjectName: this.subjectOf(c.subjectId)?.name ?? '',
        color: c.color ?? SUBJECT_FALLBACK_COLOR[c.subjectId],
        durationMinutes: courseDurationById.get(Number(c.id)) ?? 90,
        studentIds: studentIdsByCourse.get(Number(c.id)) ?? [],
      })),
    };
  }

  /** 세션 참가자 검증 SSOT. 과목/수강 관계와 독립적으로 학생 실존·캘린더 노출 상태·중복만 확인한다. */
  validateSessionStudentIds(studentIds?: readonly number[]): void {
    if (!studentIds?.length) return;
    const normalized = studentIds.map(Number);
    if (new Set(normalized).size !== normalized.length) {
      throw new BadRequestException('학생은 중복 선택할 수 없습니다.');
    }
    const bad = normalized.filter((id) => {
      const student = this.studentOf(id);
      return student == null || !isScheduleVisibleStudentStatus(student.status);
    });
    if (bad.length) {
      throw new BadRequestException(`수업 참가자로 추가할 수 없는 학생입니다: studentId ${bad.join(', ')}`);
    }
  }

  // 세션 생성(추천→배정). FK 검증 + 충돌 검사(force 아니면 충돌 시 409).
  /** 세션 입력 공통 검증(FK·참가자) — create와 schedule-requests가 **같은 함수** 사용(우회 경로 방지).
   *  반환: 확정 instructorId. undefined는 코스 기본값, null은 명시적 배정중이다. */
  validateSessionInput(input: { courseId: number; instructorId?: number | null; roomId?: number; studentIds?: number[] }): number | null {
    const course = this.courseOf(input.courseId);
    if (!course) throw new BadRequestException(`courseId ${input.courseId} 없음`);
    const instructorId = input.instructorId === undefined ? course.instructorId : input.instructorId;
    if (instructorId != null && !this.isScheduleOwner(instructorId)) throw new BadRequestException(`instructorId ${instructorId}는 활성 강사 또는 대표가 아닙니다`);
    if (input.roomId != null && !this.rooms.findAll().some((r) => r.id === input.roomId))
      throw new BadRequestException(`roomId ${input.roomId} 없음`);
    this.validateSessionStudentIds(input.studentIds);
    return instructorId;
  }

  /** 강사 승인 요청의 DB 권위 경계.
   *  프론트의 scoped resource picker를 신뢰하지 않고 코스 기본 강사·요청 강사·JWT actor가 모두 같은지
   *  매 요청마다 실제 course row로 재검증한다. 상담 일정은 관리 역할만 생성한다. */
  validateInstructorRequestInput(
    input: { courseId: number; instructorId?: number | null; roomId?: number; studentIds?: number[]; kind?: ClassSession['kind'] },
    actorInstructorId: number,
  ): number {
    const course = this.courseOf(input.courseId);
    if (!course) {
      const resolved = this.validateSessionInput(input);
      if (resolved == null) throw new ForbiddenException('강사는 배정중 코스의 수업을 요청할 수 없습니다.');
      return resolved;
    }
    if (course.instructorId == null || Number(course.instructorId) !== Number(actorInstructorId)
      || input.instructorId === null
      || (input.instructorId !== undefined && Number(input.instructorId) !== Number(actorInstructorId))) {
      throw new ForbiddenException('강사는 본인이 담당하는 코스의 수업만 요청할 수 있습니다.');
    }
    if (input.kind === 'counsel') {
      throw new ForbiddenException('상담 일정은 관리 역할만 생성할 수 있습니다.');
    }
    const resolved = this.validateSessionInput(input);
    if (resolved == null) throw new ForbiddenException('강사는 배정중 코스의 수업을 요청할 수 없습니다.');
    if (input.studentIds?.length) {
      const allowed = new Set(this.resources({ instructorId: actorInstructorId }).students.map((student) => Number(student.id)));
      const bad = input.studentIds.filter((studentId) => !allowed.has(Number(studentId)));
      if (bad.length) throw new ForbiddenException('강사는 조회 권한이 있는 학생만 수업 참가자로 지정할 수 있습니다.');
    }
    return resolved;
  }



  // 충돌 드라이런(생성·이동 전 검사)
  checkConflicts(input: {
    sessionDate: string; startTime: string; endTime?: string; durationMinutes?: number;
    instructorId?: number; roomId?: number; studentIds?: number[]; ignoreSessionId?: number; mode?: ClassSession['mode'];
  }): Conflict[] {
    // [R-9] endTime/durationMinutes를 그대로 전달 — conflict.util이 자정 크로스(익일 종료)까지 해석.
    return detectConflicts(
      { sessionDate: input.sessionDate, startTime: input.startTime, endTime: input.endTime, durationMinutes: input.durationMinutes, instructorId: input.instructorId, roomId: input.roomId, studentIds: input.studentIds, ignoreSessionId: input.ignoreSessionId, mode: input.mode },
      this.db.findAll<ClassSession>(SESSIONS),
      this.availability.list(),
      this.effectiveStudentIds,
        (roomId) => this.rooms.capacityOf(roomId), // [B4] 정원 강제 // [TBO-28C] 학생 세션 간 중복 포함
    );
  }


  /** enriched 읽기모델 변환 — 목록·단건·명령 응답이 공유(발행 계약 ScheduleRow). */
  enrich(s: ClassSession, rooms: Map<number, { name: string }>): ScheduleRow {
    const c = this.courseOf(s.courseId);
    // 명시 코호트(v0.1.13) 우선 — 미지정 시 기존대로 코스 활성 수강생 파생(하위 호환)
    const studentIds = s.studentIds?.length ? s.studentIds.map(Number) : this.activeStudentIds(s.courseId);
    const attendanceRequirement = attendanceRequirementOf(
      s,
      buildCohortIndex(this.db.findAll<Enrollment>(ENROLLMENTS_COL)),
      this.db.findByField<Attendance>(ATTENDANCE, 'sessionId', s.id),
      Date.now(),
    );
    return {
      ...s,
      kind: s.kind ?? SESSION_DEFAULTS.kind, // [v0.1.14] 시드·구데이터 하위호환(미지정=class)
      mode: s.mode ?? SESSION_DEFAULTS.mode, // [v0.1.16] 하위호환(미지정=대면)
      weekday: weekdayOf(s.sessionDate),
      // [R-9→C4] 자정 크로스(시작+진행≥24:00)면 endTime 미제공(null→undefined) — FE가 durationMinutes로 파생(단일 규칙)
      endTime: s.endTime ?? (s.startTime ? endTimeOf(s.startTime, s.durationMinutes) ?? undefined : undefined),
      courseName: c?.name ?? `course ${s.courseId}`,
      subjectName: this.subjectOf(c?.subjectId)?.name ?? '',
      instructorName: s.instructorId == null ? null : this.instructorName(s.instructorId) ?? `강사 ${s.instructorId}`,
      roomName: s.roomId ? rooms.get(s.roomId)?.name : undefined,
      color: s.color ?? c?.color ?? (c ? SUBJECT_FALLBACK_COLOR[c.subjectId] : undefined), // 세션 → 코스 → 과목 폴백
      studentIds,
      studentNames: studentIds.map((sid) => this.studentOf(sid)?.name ?? `학생 ${sid}`),
      ...attendanceRequirement,
      // [TBO-29C C3] series edit CAS — 클라이언트가 scope 편집/삭제 시 expectedSeriesVersion으로 회신
      seriesVersion: s.seriesId != null ? this.db.findById<ScheduleSeriesRow>(CLASS_SESSION_SERIES, s.seriesId)?.version : undefined,
    };
  }

}
