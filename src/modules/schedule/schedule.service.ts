import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Conflict, CreateScheduleSeriesResult, ScheduleRow, ScheduleSeries } from '@kms545487/contracts';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { RoomsService } from '../rooms/rooms.service';
import { AvailabilityService } from '../availability/availability.service';
import { AuditService } from '../audit/audit.service';
import { AttendanceService } from '../attendance/attendance.service';
import { ReportsService } from '../reports/reports.service';
import { ClassSession, SESSIONS } from './schedule.entity';
import { detectConflicts } from './conflict.util';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { Course, COURSES as COURSES_COL } from '../courses/course.entity';
import { CoursesService } from '../courses/courses.service';
import { Subject, SUBJECTS as SUBJECTS_COL } from '../subjects/subject.entity';
import { Student, STUDENTS as STUDENTS_COL } from '../students/student.entity';
import { isScheduleVisibleStudentStatus } from '../students/student-status.policy';
import { Enrollment, ENROLLMENTS as ENROLLMENTS_COL } from '../enrollments/enrollment.entity';
import { USERS, isActiveInstructor, isActiveScheduleOwner, type StaffAccount } from '../users/user.entity'; // 일정 owner=강사+대표
import { ClassSessionsStore } from './class-sessions.store';
import { CLASS_SESSION_SERIES, type ScheduleSeriesRow } from './schedule-series.entity';
import { selectSeriesScope, type SeriesScope } from './series-scope.policy';
import { addMinutesGuarded, normalizeSessionTime, storedEndTimeOf, SESSION_TIME_DEFAULTS } from './session-time.policy';
import { CreateScheduleSeriesDto } from './dto/create-schedule-series.dto';
import { CalendarUnitOfWork, type CalendarLockKey } from '../../database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { CLASS_SESSION_SERIES_SPEC, USERS_SPEC } from '../../database/calendar-asset-specs';
import { accountingImpactOf, combineAccountingImpacts, countsForTeachingHours, isPayoutLocked, payoutIdOf, teachingMinutesOf, type SessionAccountingImpact } from './session-accounting.policy';
import { studentBelongsToSession } from './session-participant.policy';
import { isSessionVisibleToInstructor } from './schedule-visibility.policy';
// [R-3 함수 통일] 시간·날짜 primitive는 common/time.util 단일 소스(로컬 중복 제거).
//  로컬 이름과 동일하게 별칭 → 호출부 무변경. addMinutes는 가드형이라 로컬 유지(아래).
import { hhmmToMin as toMin, weekdayOf, dateToYmd as fmt, addDaysISO, dayDiff } from '../../common/time.util';
import { testBusinessFixturesEnabled } from '../../config/test-fixtures';

// [감사 A, 2026-07-02] 하드코딩 상수(STUDENTS_LBL/COURSE_STUDENTS/COURSES/SUBJECTS) 제거 —
//  코호트·카탈로그는 실제 컬렉션(students/enrollments/courses/subjects)을 조회한다(단일 소스).
//  이전엔 상수 + `status !== 'drop'`(존재하지 않는 상태값 — 실제 소프트삭제는 'canceled') 필터라
//  학생 삭제·신규 수강이 캘린더에 반영되지 않는 무결성 버그가 있었다.
// [강사 식별자 통일 2026-07-07] 강사 = users(role='instructor'), 강사 id = users.id.
//  하드코딩 INSTRUCTORS 상수/브리지 폐기 — 이름/검증/피커는 instructorUsers/instructorName/isInstructor 헬퍼로 users 조회.
// 과목 색 폴백(표시용) — Subject 계약에 color가 없어 세션→코스 색이 모두 없을 때만 사용.
const SUBJECT_FALLBACK_COLOR: Record<number, string> = { 1: '#0969da', 2: '#1a7f37' };

// [R-3 2차] 세션 필드 기본값 단일 소스 — create·mergeFields·enrich가 공유(리터럴 중복 제거·단일 책임).
//  하위호환 폴백값(구데이터·미지정 입력)을 한 곳에서 관리 → 필드 추가 시 여기만 갱신.
const SESSION_DEFAULTS = {
  kind: 'class',
  mode: 'in_person',
  status: 'scheduled',
  durationMinutes: SESSION_TIME_DEFAULTS.durationMinutes, // [C4] 시간 기본값은 session-time.policy가 소유
} as const satisfies { kind: ClassSession['kind']; mode: ClassSession['mode']; status: ClassSession['status']; durationMinutes: number };

// ── [TBO-29C C4] 시간 정규화는 session-time.policy가 단일 소스 — 로컬 사본(addMinutes/endTimeOf/
//  assertDuration/CROSS_MAX_MIN)을 폐기하고 별칭으로 위임한다. 자정 크로스 endTime은 **명시 null**
//  (undefined는 PG UPDATE payload에서 skip돼 이전 end_time이 잔존 — 메모리/PG 투영 편차의 근본 원인).
const addMinutes = addMinutesGuarded;
const endTimeOf = storedEndTimeOf;
function mondayOfThisWeekUTC(): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=일
  const diff = dow === 0 ? -6 : 1 - dow; // 월요일로 이동
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

// 주간 반복 시리즈 시드 정의 — 같은 시리즈는 한 seriesId를 공유(반복 편집 데모용).
// instructorId·topic을 시드에 직접 명시(코스 시드와 정렬) — onModuleInit 실행 순서상
// courses 컬렉션이 아직 비어 있을 수 있어 시드만큼은 컬렉션을 참조하지 않는다.
type SeedSeries = { courseId: number; instructorId: number; topic: string; roomId: number; weekdayOffsets: number[]; startTime: string; durationMinutes: number; mode?: ClassSession['mode'] };
// 병합된 세션 필드(업데이트 적용 단위) — 이동/리사이즈/편집 공통.
type MergedFields = {
  studentIds?: number[]; // 명시 코호트(v0.1.13)
  // [R-9→C4] endTime은 자정 크로스(익일 종료)면 **명시 null** — durationMinutes 파생(단일 세션 모델).
  //  undefined는 PG UPDATE에서 skip돼 이전 값이 잔존하므로 update 경로는 null을 강제한다.
  sessionDate: string; startTime: string; endTime?: string | null; durationMinutes: number;
  courseId: number; instructorId: number; roomId?: number; status: ClassSession['status']; topic?: string; memo?: string; color?: string;
  instructorAttendance?: ClassSession['instructorAttendance'] | null;
  kind?: ClassSession['kind']; price?: number; // [v0.1.14]
  mode?: ClassSession['mode']; // [v0.1.16] 수업방식
  isPublic?: boolean;
};

@Injectable()
export class ScheduleService implements OnModuleInit {
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
  ) {}

  // 이번 주 데모 수업 시드 — 주간 반복 시리즈 단위(같은 시리즈=한 seriesId). 충돌 없게 구성.
  async onModuleInit(): Promise<void> {
    await this.sessions.ensureReady();
    if (this.db.findAll<ClassSession>(SESSIONS).length) return;
    // [시범운영 2026-07-15] 회차는 insert로 시드해 store.seed 관문을 우회 — 명시 게이트 추가.
    if (!testBusinessFixturesEnabled()) return;
    const mon = mondayOfThisWeekUTC();
    const series: SeedSeries[] = [
      // SAT Reading 정규(강사1·강의실1) — 월·수·금 16:00
      { courseId: 10, instructorId: 1, topic: 'SAT Reading 정규', roomId: 1, weekdayOffsets: [0, 2, 4], startTime: '16:00', durationMinutes: 90 },
      // AP Calculus BC(강사2·강의실3) — 화·목 16:00
      { courseId: 11, instructorId: 2, topic: 'AP Calculus BC', roomId: 3, weekdayOffsets: [1, 3], startTime: '16:00', durationMinutes: 120 },
      // TOEFL 정규(강사1·강의실2) — 월·수 18:00 · [v0.1.16] 비대면(미국 학생 수강 — 수업방식 필터 데모)
      { courseId: 12, instructorId: 1, topic: 'TOEFL 정규', roomId: 2, weekdayOffsets: [0, 2], startTime: '18:00', durationMinutes: 90, mode: 'online' },
    ];
    // [TBO-29C C2] class_sessions.series_id FK 승격 — 시리즈 자산 행을 회차보다 먼저 시드.
    let seedSid = 0;
    const seriesRows = series.map((sr) => {
      const dates = sr.weekdayOffsets.map((off) => { const d = new Date(mon); d.setUTCDate(d.getUTCDate() + off); return fmt(d); });
      return {
        id: ++seedSid,
        repeatKind: 'custom' as const,
        weekdays: [...new Set(dates.map((d) => weekdayOf(d)))].sort(),
        startsOn: dates[0],
        endsOn: dates[dates.length - 1],
        startTime: sr.startTime,
        durationMinutes: sr.durationMinutes,
        timeZone: 'Asia/Seoul',
        version: 1,
      };
    });
    await this.collections.seed<ScheduleSeriesRow>(CLASS_SESSION_SERIES_SPEC, seriesRows);

    let seriesId = 0;
    for (const sr of series) {
      const sid = ++seriesId;
      for (const off of sr.weekdayOffsets) {
        const date = new Date(mon);
        date.setUTCDate(date.getUTCDate() + off);
        await this.sessions.insert({
          seriesId: sid,
          courseId: sr.courseId,
          instructorId: sr.instructorId,
          roomId: sr.roomId,
          sessionDate: fmt(date),
          startTime: sr.startTime,
          endTime: addMinutes(sr.startTime, sr.durationMinutes),
          durationMinutes: sr.durationMinutes,
          status: 'scheduled',
          topic: sr.topic,
          mode: sr.mode, // [v0.1.16] 미지정=enrich가 in_person 하위호환
        } as Omit<ClassSession, keyof BaseRow>);
      }
    }

    // 보강 픽스처: 강사1(박지훈)의 점심 불가시간(월 12:00-13:00)과 겹치지 않게 둔다.
    // 불가시간과 실제 수업이 겹치는 시드는 운영 논리상 모순이므로 e2e로 금지한다.
    const mon0 = fmt(mon);
    // 표기는 실제 데이터(강사·수업명)로 깔끔하게 — "데모" 문구 금지(피드백 2026-07-02).
    await this.sessions.insert({
      courseId: 12, instructorId: 1, roomId: 2,
      sessionDate: mon0, startTime: '13:00', endTime: '14:00', durationMinutes: 60,
      status: 'scheduled', topic: 'TOEFL 정규 — 보강', mode: 'online', // [v0.1.16]
    } as Omit<ClassSession, keyof BaseRow>);

    // ── 과거 히스토리 시드(프론트 mock 이관) — 오늘 기준 상대 날짜. 지난 held/취소/보강 =
    //   리포트 미작성·강사/학생 출결·보강 필요 대시보드 데모용. 고정 id(20~28)로 attendance/reports FK 정합.
    //   held·makeup에는 강사 출결(instructorAttendance) 부여. 과거(이번 주 이전)라 이번 주 캘린더/schedule e2e에 미포함.
    const dOff = (off: number) => { const x = new Date(mon); x.setUTCDate(x.getUTCDate() + off); return fmt(x); };
    const hist: Array<Omit<ClassSession, 'id' | 'createdAt' | 'updatedAt'> & { id: number }> = [
      // 2주 전(held) — 강사 출결 present/late
      { id: 20, courseId: 10, instructorId: 1, roomId: 1, sessionDate: dOff(-12), startTime: '16:00', endTime: '17:30', durationMinutes: 90, status: 'held', instructorAttendance: 'present', topic: 'Reading: 주제·요지' },
      { id: 21, courseId: 11, instructorId: 2, roomId: 3, sessionDate: dOff(-13), startTime: '18:00', endTime: '20:00', durationMinutes: 120, status: 'held', instructorAttendance: 'present', topic: '미분 응용' },
      { id: 22, courseId: 12, instructorId: 1, roomId: 2, sessionDate: dOff(-14), startTime: '18:00', endTime: '19:30', durationMinutes: 90, status: 'held', instructorAttendance: 'late', topic: 'TOEFL Reading 스킬' },
      // 지난주(held)
      { id: 26, courseId: 10, instructorId: 1, roomId: 1, sessionDate: dOff(-5), startTime: '16:00', endTime: '17:30', durationMinutes: 90, status: 'held', instructorAttendance: 'present', topic: 'Reading: 추론(Inference) 전략' },
      { id: 27, courseId: 11, instructorId: 2, roomId: 3, sessionDate: dOff(-6), startTime: '18:00', endTime: '20:00', durationMinutes: 120, status: 'held', instructorAttendance: 'present', topic: '적분 응용(부분적분)' },
      { id: 28, courseId: 12, instructorId: 1, roomId: 2, sessionDate: dOff(-7), startTime: '18:00', endTime: '19:30', durationMinutes: 90, status: 'held', instructorAttendance: 'present', topic: 'TOEFL Writing 통합형' },
      // 취소(보강 필요) / 보강
      { id: 23, courseId: 10, instructorId: 1, roomId: 1, sessionDate: dOff(-4), startTime: '16:00', endTime: '17:30', durationMinutes: 90, status: 'canceled', topic: 'Reading: 문장 삽입(취소)' },
      { id: 24, courseId: 12, instructorId: 1, roomId: 2, sessionDate: dOff(-11), startTime: '18:00', endTime: '19:30', durationMinutes: 90, status: 'canceled', topic: 'TOEFL Listening(취소)' },
      { id: 25, courseId: 12, instructorId: 1, roomId: 2, sessionDate: dOff(-9), startTime: '18:00', endTime: '19:30', durationMinutes: 90, status: 'makeup', instructorAttendance: 'makeup', topic: 'TOEFL Listening(보강)', makeupForSessionId: 24 },
    ];
    await this.sessions.seed(hist);
  }

  // [EP2 2026-07-16] 읽기 경로 hydrate 게이트 — 종전엔 캘린더 진입 시 읽기 라우트 **각각**이
  //  4테이블(class_sessions·availability·users·series) SELECT * 전량 재적재(Neon WAN 왕복 합산).
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
    // [TBO-28F] users도 재조회 — 다른 인스턴스에서 승인/등록된 계정이 리소스·검증에 즉시 반영.
    // [TBO-29C C2→C5 성능 수정] pg tx **안**(refreshAfterLock)에서는 단일 커넥션이라 순차 실행,
    //  tx **밖**(일반 조회 경로)에서는 병렬 — 순차 고정이 Neon(WAN) 왕복 지연을 합산시켜
    //  release 게이트 db-crud가 타임아웃하는 회귀를 만들었다(실측 2026-07-15).
    const tasks = [
      () => this.sessions.ensureReady(),
      () => this.availability.refresh(),
      () => this.collections.hydrate<StaffAccount>(USERS_SPEC),
      () => this.collections.hydrate<ScheduleSeriesRow>(CLASS_SESSION_SERIES_SPEC),
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
  }

  // [TBO-28C] 캘린더 명령의 advisory lock 키 — 대상 강사·강의실·학생·세션. UoW.lockTargets가 정렬·중복 제거.
  private calendarLockKeys(t: {
    instructorIds?: Array<number | undefined>;
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
    await this.ensureReady();
  }

  /** [TBO-28C] 학생 세션 간 중복 검사용 유효 코호트 리졸버(명시 studentIds ?? 코스 활성 수강생). */
  private effectiveStudentIds = (s: ClassSession): number[] =>
    s.studentIds?.length ? s.studentIds : this.activeStudentIds(s.courseId);

  // ── 카탈로그/명단 조회(단일 소스 = 실제 컬렉션) — 감사 A ──
  private courseOf(id: number): Course | undefined {
    return this.courses.findOptional(id);
  }
  private subjectOf(id?: number): Subject | undefined {
    return id == null ? undefined : this.db.findById<Subject>(SUBJECTS_COL, id);
  }
  private studentOf(id: number): Student | undefined {
    return this.db.findById<Student>(STUDENTS_COL, id);
  }
  // [강사 식별자 통일] 강사 = users(role='instructor'), 강사 id = users.id.
  // [TBO-28B] 중앙 술어 isActiveInstructor(role=instructor AND status=active AND 미삭제) —
  //  pending/rejected 강사가 리소스 피커·세션 배정에 노출되던 갭 차단(28A 조사 §2).
  private scheduleOwnerUsers(): StaffAccount[] {
    return this.db.findBy<StaffAccount>(USERS, (u) => isActiveScheduleOwner(u));
  }
  private instructorName(id?: number): string | undefined {
    return id == null ? undefined : this.db.findById<StaffAccount>(USERS, id)?.name;
  }
  private isScheduleOwner(id: number): boolean {
    return isActiveScheduleOwner(this.db.findById<StaffAccount>(USERS, id));
  }
  // 코호트 = 활성 수강(enrollment.status==='active') ∧ 캘린더 노출 상태 학생.
  //  students.remove(소프트삭제)가 학생·수강 모두 'canceled'로 정리하므로 삭제 즉시 코호트에서 빠진다.
  private activeStudentIds(courseId: number): number[] {
    // 인덱스 조회(courseId) — enrich가 세션마다 호출하는 핫패스(전체 스캔 제거)
    return this.db
      .findByField<Enrollment>(ENROLLMENTS_COL, 'courseId', courseId)
      .filter((e) => e.status === 'active')
      .map((e) => e.studentId)
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
  // studentId 필터: 해당 학생이 활성 수강 중인 코스의 세션만(enrollments 역추적 — 단일 소스).
  list(opts: { from?: string; to?: string; instructorId?: number; roomId?: number; studentId?: number }): ScheduleRow[] {
    const rooms = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    const coursesOfStudent = opts.studentId != null
      ? new Set(
          this.db
            .findByField<Enrollment>(ENROLLMENTS_COL, 'studentId', opts.studentId)
            .filter((e) => e.status === 'active')
            .map((e) => e.courseId),
        )
      : null;
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
        (coursesOfStudent ? coursesOfStudent.has(s.courseId) : true),
      )
      .map((s) => this.enrich(s, rooms))
      .sort((a, b) => (a.sessionDate + (a.startTime ?? '')).localeCompare(b.sessionDate + (b.startTime ?? '')));
  }

  listVisible(
    opts: { from?: string; to?: string; instructorId?: number; roomId?: number; studentId?: number },
    viewerInstructorId: number,
  ): ScheduleRow[] {
    return this.list(opts).filter((row) => isSessionVisibleToInstructor(row, viewerInstructorId));
  }

  // [TBO-19] 강사 출결 현황 집계(관리자 대시보드) — 기간·강사 필터.
  //  · 카운트(출/지/결/보강/미표시)는 **진행 회차(held·makeup)** 기준(마킹 대상).
  //  · 인정 시수는 **시수 정책**(status='held' && 결석 아님 — 보강 제외, payouts와 동일 규칙).
  //  ⚠ DB 이관(TBO-08): 지금은 in-memory 전 세션 스캔+집계 → Postgres에선 **class_sessions GROUP BY instructor_id**
  //    (WHERE date BETWEEN·status IN, deleted_at IS NULL)로 승격. 규칙(카운트 모집단·시수)은 그대로 유지.
  instructorAttendanceSummary(opts: { from?: string; to?: string; instructorId?: number }): {
    from?: string; to?: string;
    rows: Array<{
      instructorId: number; instructorName: string;
      held: number; present: number; late: number; absent: number; makeup: number; unmarked: number;
      attendanceRate: number | null; teachingMinutes: number; teachingHours: number;
    }>;
    totals: { instructors: number; held: number; present: number; late: number; absent: number; makeup: number; unmarked: number; teachingHours: number };
  } {
    const sessions = this.list(opts).filter((r) =>
      (r.status === 'held' || r.status === 'makeup')
      && isActiveInstructor(this.db.findById<StaffAccount>(USERS, Number(r.instructorId))));
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
    // 코스 진행시간은 그 코스의 기존 세션에서 파생(단일 소스). 세션 없으면 기본 90분.
    const allSessions = this.db.findAll<ClassSession>(SESSIONS);
    const courseDuration = (courseId: number): number =>
      allSessions.find((s) => s.courseId === courseId)?.durationMinutes ?? 90;
    const courses = this.db
      .findAll<Course>(COURSES_COL)
      .filter((c) => scope?.instructorId == null || Number(c.instructorId) === Number(scope.instructorId));
    const scopedCourseIds = new Set(courses.map((c) => Number(c.id)));
    const scopedStudentIds = scope?.instructorId == null
      ? null
      : new Set(
          this.db
            .findAll<Enrollment>(ENROLLMENTS_COL)
            .filter((e) => e.status === 'active' && scopedCourseIds.has(Number(e.courseId)))
            .map((e) => Number(e.studentId)),
        );
    return {
      instructors: this.scheduleOwnerUsers().filter((u) => scope?.instructorId == null || Number(u.id) === Number(scope.instructorId)).map((u) => {
        const c = courses.find((x) => x.instructorId === u.id);
        return {
          type: 'instructor' as const, id: u.id, name: u.name,
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
          sub: s.grade != null ? `${s.grade}학년` : undefined,
          countryCode: s.country,
        })),
      courses: courses.map((c) => ({
        id: c.id, name: c.name, instructorId: c.instructorId,
        instructorName: this.instructorName(c.instructorId) ?? '',
        subjectName: this.subjectOf(c.subjectId)?.name ?? '',
        color: c.color ?? SUBJECT_FALLBACK_COLOR[c.subjectId],
        durationMinutes: courseDuration(c.id),
      })),
    };
  }

  // 세션 생성(추천→배정). FK 검증 + 충돌 검사(force 아니면 충돌 시 409).
  /** [TBO-16 #9] 세션 입력 공통 검증(FK·코호트) — create와 schedule-requests가 **같은 함수** 사용(우회 경로 방지).
   *  반환: 확정 instructorId(미지정=코스 기본 강사). */
  validateSessionInput(input: { courseId: number; instructorId?: number; roomId?: number; studentIds?: number[] }): number {
    const course = this.courseOf(input.courseId);
    if (!course) throw new BadRequestException(`courseId ${input.courseId} 없음`);
    const instructorId = input.instructorId ?? course.instructorId;
    if (!this.isScheduleOwner(instructorId)) throw new BadRequestException(`instructorId ${instructorId}는 활성 강사 또는 대표가 아닙니다`);
    if (input.roomId != null && !this.rooms.findAll().some((r) => r.id === input.roomId))
      throw new BadRequestException(`roomId ${input.roomId} 없음`);
    if (input.studentIds?.length) {
      const allowed = new Set(this.activeStudentIds(input.courseId));
      const bad = input.studentIds.filter((id) => !allowed.has(id));
      if (bad.length) throw new BadRequestException(`이 코스의 활성 수강생이 아닙니다: studentId ${bad.join(', ')}`);
    }
    return instructorId;
  }

  async create(dto: {
    courseId: number; instructorId?: number; roomId?: number; sessionDate: string;
    startTime: string; endTime?: string; durationMinutes?: number; topic?: string; memo?: string; color?: string;
    studentIds?: number[]; // 명시 코호트(v0.1.13)
    seriesId?: number; status?: ClassSession['status']; force?: boolean;
    kind?: ClassSession['kind']; price?: number; // [v0.1.14] 종류·세션 단건 가격
    mode?: ClassSession['mode']; // [v0.1.16] 수업방식(기본 in_person)
    isPublic?: boolean;
    makeupForSessionId?: number; // [대표 지시 ⑭ 2026-07-16] 보강 세션 → 원본(결강) 세션 링크
  }, actorId?: number): Promise<{ row: ScheduleRow; conflicts: Conflict[] }> {
    await this.ensureReady();
    const instructorId = this.validateSessionInput(dto); // FK·코호트 공통 검증(함수 통일)
    const course = this.courseOf(dto.courseId)!;
    const studentIds = dto.studentIds?.length ? dto.studentIds : this.activeStudentIds(dto.courseId);

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
      // [TBO-29C C2] seriesId는 서버 발급 자산만 허용 — 유령 시리즈 참조 차단(PG FK와 동일 규칙을 메모리에도).
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
        { sessionDate: dto.sessionDate, startTime, durationMinutes, instructorId, roomId: dto.roomId, studentIds, mode: dto.mode ?? SESSION_DEFAULTS.mode },
        this.db.findAll<ClassSession>(SESSIONS),
        this.availability.list(),
        this.effectiveStudentIds,
        (roomId) => this.rooms.capacityOf(roomId), // [B4] 정원 강제
      );
      // 디버깅: 생성 요청 + 충돌 현황 로깅
      if (conflicts.length && !dto.force) {
        this.logger.warn(`create 충돌 ${conflicts.length}건 — course=${dto.courseId} ${dto.sessionDate} ${dto.startTime} (force로 강제 가능)`);
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
        await this.audit.log({ entity: SESSIONS, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
      return { row: created, conflicts };
    });
    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return { row: this.enrich(row, roomsMap), conflicts };
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
    await this.ensureReady();
    const instructorId = this.validateSessionInput(dto); // FK·코호트 공통 검증(단건 create와 같은 함수)
    const course = this.courseOf(dto.courseId)!;
    const studentIds = dto.studentIds?.length ? dto.studentIds : this.activeStudentIds(dto.courseId);
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

      // 전체 conflict 선계산 — 어떤 회차도 쓰기 전에 모든 날짜를 검사(부분 커밋 원천 차단).
      const existing = this.db.findAll<ClassSession>(SESSIONS);
      const allConflicts: Conflict[] = [];
      for (const sessionDate of dates) {
        allConflicts.push(...detectConflicts(
          { sessionDate, startTime, durationMinutes, instructorId, roomId: dto.roomId, studentIds, mode: dto.mode ?? SESSION_DEFAULTS.mode },
          existing,
          this.availability.list(),
          this.effectiveStudentIds,
        (roomId) => this.rooms.capacityOf(roomId), // [B4] 정원 강제
        ));
      }
      if (allConflicts.length && !dto.force) {
        this.logger.warn(`createSeries 충돌 ${allConflicts.length}건 — course=${dto.courseId} ${dates[0]}~${dates[dates.length - 1]} ${startTime} (force로 강제 가능)`);
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
    return { series: seriesOut, rows: result.rows.map((r) => this.enrich(r, roomsMap)), conflicts: result.conflicts };
  }

  // 세션 삭제 — [v9] soft delete(행 보존·deletedBy 기록) + audit before 스냅샷 + 동반 정리(출결·리포트) 단일 tx.
  //  [TBO-28C] 대상 세션 잠금 + 잠금 후 권위 재조회(동시 update/delete 경쟁 직렬화 — payout-lock 판정도 tx 안).
  //  [TBO-29C C3] scope(this/this_and_following/all) 지원 — 대상 집합은 selectSeriesScope(순수),
  //  payout lock·의존 cascade는 **삭제 전 전 회차 사전 검증**(하나라도 걸리면 아무것도 삭제하지 않음),
  //  회차별 audit(before 스냅샷)+공통 correlation, series version CAS/endsOn 축소/전량 삭제 시 series soft delete.
  async remove(
    id: number,
    actorId?: number,
    opts?: { scope?: SeriesScope; expectedSeriesVersion?: number },
  ): Promise<{ id: number; deleted: boolean; removedIds: number[] }> {
    await this.ensureReady();
    const scope = opts?.scope ?? 'this';
    const pre = this.db.findById<ClassSession>(SESSIONS, id);
    if (!pre) throw new NotFoundException(`Session ${id} not found`);
    return this.unitOfWork.run(async () => {
      await this.unitOfWork.lockTargets([
        { kind: 'session', id },
        ...(pre.seriesId != null ? [{ kind: 'series' as const, id: Number(pre.seriesId) }] : []),
      ]);
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
        if (companions.length) {
          await this.unitOfWork.lockTargets(this.calendarLockKeys({ sessionIds: companions.map((m) => m.id) }));
          await this.refreshAfterLock();
          companions = selectSeriesScope(this.db.findBy<ClassSession>(SESSIONS, (s) => s.seriesId === before.seriesId), before, scope);
        }
      }
      const targets = [before, ...companions];
      // [C3] 전 회차 사전 검증 — 정산 연결이 하나라도 있으면 전체 불변(부분 삭제 금지).
      const locked = targets.filter((t) => isPayoutLocked(t));
      if (locked.length) {
        throw new ConflictException({
          code: 'PAYOUT_REVERSAL_REQUIRED',
          message: `정산서에 연결된 수업(${locked.map((t) => `${t.id}(정산 ${payoutIdOf(t)})`).join(', ')})은 정산 회수 전 삭제할 수 없습니다`,
          sessionIds: locked.map((t) => t.id),
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
        if (deleted && actorId != null)
          await this.audit.log({ entity: SESSIONS, entityId: t.id, action: 'delete', actorId, changes: this.audit.snapshotOf(snap) as never, reason: correlation });
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
      return { id, deleted: removedIds.includes(id), removedIds };
    });
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

  // 이동·리사이즈·상세편집. 충돌 시(force 아니면) 409 + conflicts 반환.
  // scope(this_and_following|all)면 같은 seriesId 세션에 동일 날짜·시간 델타를 함께 적용.
  async update(id: number, dto: UpdateScheduleDto, actorId?: number): Promise<{ row: ScheduleRow; conflicts: Conflict[]; updated: number }> {
    await this.ensureReady();
    // [명시 코호트 v0.1.13] 부분집합 검증 — create와 동일 규칙(함수 통일: activeStudentIds 단일 소스)
    if (dto.studentIds?.length) {
      const cur0 = this.db.findById<ClassSession>(SESSIONS, id);
      const allowed = new Set(this.activeStudentIds(dto.courseId ?? cur0?.courseId ?? 0));
      const bad = dto.studentIds.filter((x) => !allowed.has(x));
      if (bad.length) throw new BadRequestException(`이 코스의 활성 수강생이 아닙니다: studentId ${bad.join(', ')}`);
    }
    // [원자성] 반복 시리즈 scope 편집 — 대상+동반 세션이 전부 반영되거나 전부 롤백(부분 편집 잔존 금지)
    // [TBO-28C] 사전 조회는 잠금 키 산정용 — 잠금 후 권위 재조회로 다시 읽는다.
    const pre = this.db.findById<ClassSession>(SESSIONS, id);
    if (!pre) throw new NotFoundException(`Session ${id} not found`);
    return this.unitOfWork.run(async () => {
    // [TBO-29C C3] 1단계 잠금: **series 키(있으면) 우선 포함** + 대상 세션 + primary 현재/목표 자원.
    //  series advisory lock이 같은 시리즈를 만지는 모든 명령(scope 편집·삭제·단건 member 편집)의 단일
    //  choke point — 구 구현은 primary session만 잠가 서로 다른 회차의 동시 scope 편집이 교차했다.
    await this.unitOfWork.lockTargets([
      ...this.calendarLockKeys({
        instructorIds: [pre.instructorId, dto.instructorId],
        roomIds: [pre.roomId, dto.roomId],
        studentIds: [...new Set([...(pre.studentIds ?? []), ...(dto.studentIds ?? [])])],
        sessionIds: [id],
      }),
      ...(pre.seriesId != null ? [{ kind: 'series' as const, id: Number(pre.seriesId) }] : []),
    ]);
    await this.refreshAfterLock();
    const cur = this.db.findById<ClassSession>(SESSIONS, id);
    if (!cur) throw new NotFoundException(`Session ${id} not found`);
    // 참조 무결성(FK) 검증
    if (dto.courseId != null && !this.courseOf(dto.courseId)) throw new BadRequestException(`courseId ${dto.courseId} 없음`);
    if (dto.instructorId != null && !this.isScheduleOwner(dto.instructorId)) throw new BadRequestException(`instructorId ${dto.instructorId}는 활성 강사 또는 대표가 아닙니다`);
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
    this.assertDependentsCompatible(cur.id, cur, primary);
    const approved = this.reports.isSessionReportComplete(cur.id);
    const primaryImpact = accountingImpactOf(cur, primary, {
      beforeApprovedReport: approved,
      afterApprovedReport: approved,
      beforeHourlyRate: this.courseOf(cur.courseId)?.hourlyRate ?? 0,
      afterHourlyRate: this.courseOf(primary.courseId)?.hourlyRate ?? 0,
    });
    const accountingImpacts: SessionAccountingImpact[] = [primaryImpact];
    const accountingLocked: ClassSession[] = isPayoutLocked(cur) ? [cur] : [];

    // 2) 시리즈 동반 편집 대상 산출(this=대상만, this_and_following=대상 이후, all=시리즈 전체)
    //    [TBO-29C C3] 대상 집합은 selectSeriesScope 순수 함수(같은 날짜의 늦은 회차도 시간·id로 판정).
    //    공통 델타: 날짜(일수)·시작시각(분). 강의실/강사/상태/시수는 절대값으로 동일 적용.
    const scope = (dto.scope ?? 'this') as SeriesScope;
    const dayDelta = dayDiff(primary.sessionDate, cur.sessionDate);
    const startDelta = toMin(primary.startTime) - toMin(cur.startTime ?? primary.startTime);
    let scopeMembers: ClassSession[] = [];
    if (scope !== 'this' && cur.seriesId != null) {
      scopeMembers = selectSeriesScope(this.db.findBy<ClassSession>(SESSIONS, (s) => s.seriesId === cur.seriesId), cur, scope);
      if (scopeMembers.length) {
        // [C3] 2단계 잠금: 모든 member 세션 + member의 현재 자원 + 목표 자원(primary 필드).
        //  series lock을 보유한 상태라 같은 시리즈 명령끼리는 이 단계에서 경쟁하지 않는다(교착 없음).
        await this.unitOfWork.lockTargets(this.calendarLockKeys({
          instructorIds: [...scopeMembers.map((m) => m.instructorId), primary.instructorId],
          roomIds: [...scopeMembers.map((m) => m.roomId), primary.roomId],
          studentIds: [...new Set(scopeMembers.flatMap((m) => m.studentIds ?? []))],
          sessionIds: scopeMembers.map((m) => m.id),
        }));
        await this.refreshAfterLock();
        // 잠금 후 재조회·재산출 — 판정에 쓰는 member 집합/필드가 권위 상태.
        scopeMembers = selectSeriesScope(this.db.findBy<ClassSession>(SESSIONS, (s) => s.seriesId === cur.seriesId), cur, scope);
      }
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
    for (const patch of seriesPatches) {
      const member = patch.before;
      if (isPayoutLocked(member)) accountingLocked.push(member);
      this.assertDependentsCompatible(member.id, member, patch.fields);
      const memberApproved = this.reports.isSessionReportComplete(member.id);
      accountingImpacts.push(accountingImpactOf(member, patch.fields, {
        beforeApprovedReport: memberApproved,
        afterApprovedReport: memberApproved,
        beforeHourlyRate: this.courseOf(member.courseId)?.hourlyRate ?? 0,
        afterHourlyRate: this.courseOf(patch.fields.courseId)?.hourlyRate ?? 0,
      }));
    }
    const impact = combineAccountingImpacts(accountingImpacts);
    const requiresAccountingAck = impact.changed && ([cur, ...seriesPatches.map((patch) => patch.before)]
      .some((session) => session?.status === 'held' || (session ? isPayoutLocked(session) : false)));
    if (accountingLocked.length) {
      throw new ConflictException({
        code: 'PAYOUT_REVERSAL_REQUIRED',
        message: `정산서에 연결된 수업(${accountingLocked.map((session) => session.id).join(', ')})은 정산 회수 또는 보정 거래 후 변경할 수 있습니다.`,
        impact,
      });
    }
    if (requiresAccountingAck && !dto.acknowledgeAccountingImpact) {
      throw new ConflictException({
        code: 'ACCOUNTING_IMPACT_ACK_REQUIRED',
        message: '완료 수업 변경으로 시수 또는 정산 예상액이 달라집니다. 변경 결과를 확인해 주세요.',
        impact,
      });
    }

    // 3) 충돌 검사(대상 + 시리즈 동반). 자기 자신과 함께 이동하는 형제는 검사에서 제외.
    const movingIds = new Set<number>([id, ...seriesPatches.map((p) => p.id)]);
    const others = this.db.findBy<ClassSession>(SESSIONS, (s) => !movingIds.has(s.id));
    const blocks = this.availability.list();
    const conflicts: Conflict[] = [];
    for (const f of [primary, ...seriesPatches.map((p) => p.fields)]) {
      conflicts.push(...detectConflicts(
        // [R-9→C4] 크로스 세션은 endTime이 null(명시) — durationMinutes로 이틀(±1일) 겹침 검사
        { sessionDate: f.sessionDate, startTime: f.startTime, endTime: f.endTime ?? undefined, durationMinutes: f.durationMinutes, instructorId: f.instructorId, roomId: f.roomId, studentIds: f.studentIds ?? this.activeStudentIds(f.courseId), mode: f.mode },
        others, blocks,
        this.effectiveStudentIds,
        (roomId) => this.rooms.capacityOf(roomId), // [B4] 정원 강제 // [TBO-28C] 학생 세션 간 중복 포함
      ));
    }
    // 결강·취소(canceled/no_show)로 바꾸는 변경은 시간 점유가 사라지므로 충돌 검사와 무관 — 항상 허용.
    const becomesCanceled = primary.status === 'canceled' || primary.status === 'no_show';
    if (conflicts.length && !dto.force && !becomesCanceled) {
      this.logger.warn(`update 충돌 ${conflicts.length}건 — session=${id} scope=${scope} (force로 강제 가능)`);
      throw new ConflictException({ message: '스케줄 충돌', conflicts });
    }

    // 4) 일괄 적용(대상 먼저, 그 뒤 시리즈)
    // [TBO-29C C3] 구 구현은 대표 세션 1건만 audit — 이제 바뀐 **모든 회차**가 개별 before/after를 남기고
    //  공통 correlation(reason: series=<id> scope=<scope> corr=<uuid>)으로 한 명령임을 추적한다.
    const correlation = cur.seriesId != null ? `series=${cur.seriesId} scope=${scope} corr=${randomUUID()}` : undefined;
    const beforeSnap = { ...cur }; // audit diff용(적용 전 상태 — cur는 라이브 행이라 사본 필수)
    const updated = (await this.sessions.update(id, primary as never))!;
    const memberAfters: Array<{ before: ClassSession; after: ClassSession | undefined }> = [];
    for (const p of seriesPatches) {
      const after = await this.sessions.update(p.id, p.fields as never);
      memberAfters.push({ before: p.before, after });
    }
    if (actorId != null) {
      const diff = this.audit.diffOf(beforeSnap, updated);
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
    return { row: this.enrich(updated, roomsMap), conflicts, updated: 1 + seriesPatches.length };
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
    const course = this.courseOf(courseId);
    const instructorId = dto.instructorId ?? (dto.courseId != null && course ? course.instructorId : cur.instructorId);
    const roomId = dto.roomId ?? cur.roomId;
    return {
      sessionDate, startTime, endTime, durationMinutes, courseId, instructorId, roomId,
      status: dto.status ?? cur.status,
      topic: dto.topic ?? (dto.courseId != null && course ? course.name : cur.topic),
      memo: dto.memo ?? cur.memo,
      color: dto.color ?? cur.color,
      // [TBO-19 Sprint2] clear=미표시로 초기화(우회 sentinel) · 아니면 기존 병합(?? cur)
      // DB에서도 실제로 비워지도록 clear는 undefined(UPDATE 생략)가 아니라 NULL을 기록한다.
      instructorAttendance: dto.clearInstructorAttendance ? null : (dto.instructorAttendance ?? cur.instructorAttendance),
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

  private assertDependentsCompatible(sessionId: number, before: ClassSession, after: MergedFields): void {
    const attendanceStudents = this.attendance.findBySession(sessionId).map((row) => row.studentId);
    const reports = this.reports.findBySession(sessionId);
    const dependentStudents = new Set([...attendanceStudents, ...reports.map((row) => row.studentId)]);
    const enrollments = this.db.findAll<Enrollment>(ENROLLMENTS_COL);
    const invalid = [...dependentStudents].filter(
      (studentId) => !studentBelongsToSession(after as ClassSession, studentId, enrollments),
    );
    if (invalid.length)
      throw new ConflictException(`세션 ${sessionId}의 출결/보고서 학생이 변경 코호트에서 제외됩니다: ${invalid.join(', ')}`);
    if (reports.length && after.instructorId !== before.instructorId)
      throw new ConflictException(`세션 ${sessionId}에 작성된 보고서가 있어 강사를 변경할 수 없습니다`);
    if (reports.length && after.courseId !== before.courseId)
      throw new ConflictException(`세션 ${sessionId}에 작성된 보고서가 있어 코스를 변경할 수 없습니다`);
  }

  private enrich(s: ClassSession, rooms: Map<number, { name: string }>): ScheduleRow {
    const c = this.courseOf(s.courseId);
    // 명시 코호트(v0.1.13) 우선 — 미지정 시 기존대로 코스 활성 수강생 파생(하위 호환)
    const studentIds = s.studentIds?.length ? s.studentIds.map(Number) : this.activeStudentIds(s.courseId);
    return {
      ...s,
      kind: s.kind ?? SESSION_DEFAULTS.kind, // [v0.1.14] 시드·구데이터 하위호환(미지정=class)
      mode: s.mode ?? SESSION_DEFAULTS.mode, // [v0.1.16] 하위호환(미지정=대면)
      weekday: weekdayOf(s.sessionDate),
      // [R-9→C4] 자정 크로스(시작+진행≥24:00)면 endTime 미제공(null→undefined) — FE가 durationMinutes로 파생(단일 규칙)
      endTime: s.endTime ?? (s.startTime ? endTimeOf(s.startTime, s.durationMinutes) ?? undefined : undefined),
      courseName: c?.name ?? `course ${s.courseId}`,
      subjectName: this.subjectOf(c?.subjectId)?.name ?? '',
      instructorName: this.instructorName(s.instructorId) ?? `강사 ${s.instructorId}`,
      roomName: s.roomId ? rooms.get(s.roomId)?.name : undefined,
      color: s.color ?? c?.color ?? (c ? SUBJECT_FALLBACK_COLOR[c.subjectId] : undefined), // 세션 → 코스 → 과목 폴백
      studentIds,
      studentNames: studentIds.map((sid) => this.studentOf(sid)?.name ?? `학생 ${sid}`),
      // [TBO-29C C3] series edit CAS — 클라이언트가 scope 편집/삭제 시 expectedSeriesVersion으로 회신
      seriesVersion: s.seriesId != null ? this.db.findById<ScheduleSeriesRow>(CLASS_SESSION_SERIES, s.seriesId)?.version : undefined,
    };
  }
}
