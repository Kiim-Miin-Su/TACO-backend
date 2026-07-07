import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Conflict, ScheduleRow } from '@kms545487/contracts';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { RoomsService } from '../rooms/rooms.service';
import { AvailabilityService } from '../availability/availability.service';
import { AuditService } from '../audit/audit.service';
import { ClassSession, SESSIONS } from './schedule.entity';
import { detectConflicts } from './conflict.util';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { Course, COURSES as COURSES_COL } from '../courses/course.entity';
import { Subject, SUBJECTS as SUBJECTS_COL } from '../subjects/subject.entity';
import { Student, STUDENTS as STUDENTS_COL } from '../students/student.entity';
import { Enrollment, ENROLLMENTS as ENROLLMENTS_COL } from '../enrollments/enrollment.entity';
import { USERS, type StaffAccount } from '../users/user.entity'; // [강사 식별자 통일] 강사=users(role=instructor)
// [R-3 함수 통일] 시간·날짜 primitive는 common/time.util 단일 소스(로컬 중복 제거).
//  로컬 이름과 동일하게 별칭 → 호출부 무변경. addMinutes는 가드형이라 로컬 유지(아래).
import { hhmmToMin as toMin, minToHhmm, weekdayOf, dateToYmd as fmt, addDaysISO, dayDiff } from '../../common/time.util';

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
  durationMinutes: 60,
} as const satisfies { kind: ClassSession['kind']; mode: ClassSession['mode']; status: ClassSession['status']; durationMinutes: number };

// ── 날짜/시간 유틸(결정론적, KST 의존 없음) — primitive는 common/time.util(위 import) ──
// [R-3] 가드형 addMinutes만 로컬 유지(허용형 minToHhmm 위에 범위 가드를 얹음 — util은 순수/허용형).
function addMinutes(hhmm: string, mins: number): string {
  const t = toMin(hhmm) + mins;
  // [M3] 시리즈 델타 적용 시 자정 범위를 벗어나면 '0-4:-30' 같은 오염 문자열이 커밋될 수 있음(코드리뷰).
  //  여기서 400을 던지면 감싼 db.transaction이 시리즈 전체를 롤백한다(부분 오염 금지).
  //  [R-9 2026-07-06] 이 가드는 이제 **시작시각**(시리즈 델타)과 24:00 미만 종료 파생에만 걸린다 —
  //  자정 크로스 종료는 endTimeOf가 미리 undefined(파생 저장)로 분기하므로 이 함수에 도달하지 않는다.
  if (t < 0 || t >= 24 * 60) throw new BadRequestException(`시간 범위를 벗어납니다(${hhmm} ${mins >= 0 ? '+' : ''}${mins}분)`);
  return minToHhmm(t);
}

// ── [R-9 2026-07-06] 자정 크로스 수업 정식 지원(옵션 B — 단일 세션 모델) ──
//  - 세션은 계속 **1레코드·sessionDate=시작일(KST)** — 분할 저장 금지(시수·출결·정산 이중 카운트 위험).
//  - 입력 규칙: endTime < startTime → **익일 종료**로 해석(예: 23:00→01:00 = 120분). 같으면 400.
//  - 저장 규칙: 종료가 24:00 이상이면 endTime을 **저장하지 않고**(HH:mm 계약 보호 — '25:00' 금지)
//    durationMinutes로 파생한다. 조회(enrich)도 동일 — 크로스 세션의 endTime은 미제공(FE가 duration 파생).
//  - 크로스 세션 duration 상한 = 480분(DTO [감사 H4]와 동일 — 시급 계산 오염 방지).
//  - 충돌 검사는 conflict.util이 절대 분 좌표(±1일)로 이틀에 걸쳐 수행.
const CROSS_MAX_MIN = 480;
/** endTime 입력 → 진행 분. 음수(익일 종료)는 +1440 래핑. 0(같은 시각)은 호출부에서 400. */
const durationFrom = (startTime: string, endTime: string): number => {
  const d = toMin(endTime) - toMin(startTime);
  return d < 0 ? d + 1440 : d;
};
/** 저장/응답용 endTime — 자정(24:00) 이상 종료면 undefined(durationMinutes 파생 규칙). */
const endTimeOf = (startTime: string, durationMinutes: number): string | undefined =>
  toMin(startTime) + durationMinutes >= 24 * 60 ? undefined : addMinutes(startTime, durationMinutes);
/** 크로스 duration 검증(공통) — 0 이하=400(같은 시각), 크로스면 상한 480분. */
function assertDuration(startTime: string, durationMinutes: number): void {
  if (durationMinutes <= 0) throw new BadRequestException('종료 시각이 시작과 같을 수 없습니다');
  if (toMin(startTime) + durationMinutes >= 24 * 60 && durationMinutes > CROSS_MAX_MIN)
    throw new BadRequestException(`자정 크로스 수업은 최대 ${CROSS_MAX_MIN}분(8시간)까지 가능합니다`);
}
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
  // [R-9] endTime은 자정 크로스(익일 종료)면 undefined — durationMinutes 파생(단일 세션 모델)
  sessionDate: string; startTime: string; endTime?: string; durationMinutes: number;
  courseId: number; instructorId: number; roomId?: number; status: ClassSession['status']; topic?: string; memo?: string; color?: string;
  instructorAttendance?: ClassSession['instructorAttendance'];
  kind?: ClassSession['kind']; price?: number; // [v0.1.14]
  mode?: ClassSession['mode']; // [v0.1.16] 수업방식
};

@Injectable()
export class ScheduleService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    private readonly db: InMemoryDatabase,
    private readonly rooms: RoomsService,
    private readonly availability: AvailabilityService,
    private readonly audit: AuditService, // [TBO-16 #7] 세션 CRUD 변경 이력(tx 동반)
  ) {}

  // 이번 주 데모 수업 시드 — 주간 반복 시리즈 단위(같은 시리즈=한 seriesId). 충돌 없게 구성.
  onModuleInit(): void {
    if (this.db.findAll<ClassSession>(SESSIONS).length) return;
    const mon = mondayOfThisWeekUTC();
    const series: SeedSeries[] = [
      // SAT Reading 정규(강사1·강의실1) — 월·수·금 16:00
      { courseId: 10, instructorId: 1, topic: 'SAT Reading 정규', roomId: 1, weekdayOffsets: [0, 2, 4], startTime: '16:00', durationMinutes: 90 },
      // AP Calculus BC(강사2·강의실3) — 화·목 16:00
      { courseId: 11, instructorId: 2, topic: 'AP Calculus BC', roomId: 3, weekdayOffsets: [1, 3], startTime: '16:00', durationMinutes: 120 },
      // TOEFL 정규(강사1·강의실2) — 월·수 18:00 · [v0.1.16] 비대면(미국 학생 수강 — 수업방식 필터 데모)
      { courseId: 12, instructorId: 1, topic: 'TOEFL 정규', roomId: 2, weekdayOffsets: [0, 2], startTime: '18:00', durationMinutes: 90, mode: 'online' },
    ];
    let seriesId = 0;
    series.forEach((sr) => {
      const sid = ++seriesId;
      sr.weekdayOffsets.forEach((off) => {
        const date = new Date(mon);
        date.setUTCDate(date.getUTCDate() + off);
        this.db.insert<ClassSession>(SESSIONS, {
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
        });
      });
    });

    // 테스트용 겹침 픽스처: 강사1(박지훈)의 점심 불가시간(월 12:00–13:00) 위에 놓인 세션.
    // 캘린더에서 강사1 선택 시 회색 불가 밴드와 겹치는 수업이 보이고, 충돌 검사 데모가 가능.
    const mon0 = fmt(mon);
    // 표기는 실제 데이터(강사·수업명)로 깔끔하게 — "데모" 문구 금지(피드백 2026-07-02).
    this.db.insert<ClassSession>(SESSIONS, {
      courseId: 12, instructorId: 1, roomId: 2,
      sessionDate: mon0, startTime: '12:30', endTime: '13:30', durationMinutes: 60,
      status: 'scheduled', topic: 'TOEFL 정규 — 보강', mode: 'online', // [v0.1.16]
    });

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
    this.db.seed<ClassSession>(SESSIONS, hist);
  }

  // ── 카탈로그/명단 조회(단일 소스 = 실제 컬렉션) — 감사 A ──
  private courseOf(id: number): Course | undefined {
    return this.db.findById<Course>(COURSES_COL, id);
  }
  private subjectOf(id?: number): Subject | undefined {
    return id == null ? undefined : this.db.findById<Subject>(SUBJECTS_COL, id);
  }
  private studentOf(id: number): Student | undefined {
    return this.db.findById<Student>(STUDENTS_COL, id);
  }
  // [강사 식별자 통일] 강사 = users(role='instructor'), 강사 id = users.id.
  private instructorUsers(): StaffAccount[] {
    return this.db.findBy<StaffAccount>(USERS, (u) => u.role === 'instructor');
  }
  private instructorName(id?: number): string | undefined {
    return id == null ? undefined : this.db.findById<StaffAccount>(USERS, id)?.name;
  }
  private isInstructor(id: number): boolean {
    return this.db.findById<StaffAccount>(USERS, id)?.role === 'instructor';
  }
  // 코호트 = 활성 수강(enrollment.status==='active') ∧ 학생 미삭제(status!=='canceled').
  //  students.remove(소프트삭제)가 학생·수강 모두 'canceled'로 정리하므로 삭제 즉시 코호트에서 빠진다.
  private activeStudentIds(courseId: number): number[] {
    // 인덱스 조회(courseId) — enrich가 세션마다 호출하는 핫패스(전체 스캔 제거)
    return this.db
      .findByField<Enrollment>(ENROLLMENTS_COL, 'courseId', courseId)
      .filter((e) => e.status === 'active')
      .map((e) => e.studentId)
      .filter((sid) => this.studentOf(sid)?.status !== 'canceled');
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
    return this.db
      .findBy<ClassSession>(SESSIONS, (s) =>
        (opts.from ? s.sessionDate >= opts.from : true) &&
        (opts.to ? s.sessionDate <= opts.to : true) &&
        (opts.instructorId ? s.instructorId === opts.instructorId : true) &&
        (opts.roomId ? s.roomId === opts.roomId : true) &&
        (coursesOfStudent ? coursesOfStudent.has(s.courseId) : true),
      )
      .map((s) => this.enrich(s, rooms))
      .sort((a, b) => (a.sessionDate + (a.startTime ?? '')).localeCompare(b.sessionDate + (b.startTime ?? '')));
  }

  // 자원 피커(좌측 레일·필터)용 경량 목록 — 강사·강의실·학생.
  resources(): import('@kms545487/contracts').ScheduleResources {
    const PALETTE = ['#0969da', '#1a7f37', '#8250df', '#bf3989', '#9a6700', '#1b7c83'];
    // 코스 진행시간은 그 코스의 기존 세션에서 파생(단일 소스). 세션 없으면 기본 90분.
    const allSessions = this.db.findAll<ClassSession>(SESSIONS);
    const courseDuration = (courseId: number): number =>
      allSessions.find((s) => s.courseId === courseId)?.durationMinutes ?? 90;
    const courses = this.db.findAll<Course>(COURSES_COL);
    return {
      instructors: this.instructorUsers().map((u) => {
        const c = courses.find((x) => x.instructorId === u.id);
        return {
          type: 'instructor' as const, id: u.id, name: u.name,
          color: PALETTE[u.id % PALETTE.length],
          sub: c ? this.subjectOf(c.subjectId)?.name : undefined,
        };
      }),
      rooms: this.rooms.findAll().map((r) => ({
        type: 'room' as const, id: r.id, name: r.name, color: r.color,
        sub: r.capacity != null ? `정원 ${r.capacity}` : undefined,
      })),
      // 학생 = students 컬렉션(단일 소스). 소프트삭제(canceled)만 제외 — 신규 등록·삭제가 즉시 반영.
      students: this.db
        .findBy<Student>(STUDENTS_COL, (s) => s.status !== 'canceled')
        .map((s) => ({
          type: 'student' as const, id: s.id, name: s.name,
          color: PALETTE[(s.id + 2) % PALETTE.length],
          sub: s.grade != null ? `${s.grade}학년` : undefined,
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
    if (!this.isInstructor(instructorId)) throw new BadRequestException(`instructorId ${instructorId} 없음`);
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
  }, actorId?: number): Promise<{ row: ScheduleRow; conflicts: Conflict[] }> {
    const instructorId = this.validateSessionInput(dto); // FK·코호트 공통 검증(함수 통일)
    const course = this.courseOf(dto.courseId)!;

    const startTime = dto.startTime;
    // [R-9] endTime<startTime = 익일 종료(자정 크로스 — +1440 래핑). 같으면 400, 크로스 상한 480분.
    const durationMinutes = dto.endTime
      ? durationFrom(startTime, dto.endTime)
      : dto.durationMinutes ?? SESSION_DEFAULTS.durationMinutes;
    assertDuration(startTime, durationMinutes);
    const endTime = endTimeOf(startTime, durationMinutes); // 크로스면 undefined(durationMinutes 파생 저장)

    const conflicts = detectConflicts(
      { sessionDate: dto.sessionDate, startTime, durationMinutes, instructorId, roomId: dto.roomId },
      this.db.findAll<ClassSession>(SESSIONS),
      this.availability.list(),
    );
    // 디버깅: 생성 요청 + 충돌 현황 로깅
    if (conflicts.length && !dto.force) {
      this.logger.warn(`create 충돌 ${conflicts.length}건 — course=${dto.courseId} ${dto.sessionDate} ${dto.startTime} (force로 강제 가능)`);
      throw new ConflictException({ message: '스케줄 충돌', conflicts });
    }

    // [원자성] 세션 생성 + 변경 이력(audit)이 함께 반영되거나 함께 롤백
    const row = await this.db.transaction(() => {
      const created = this.db.insert<ClassSession>(SESSIONS, {
        studentIds: dto.studentIds,
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
        price: dto.price,
        topic: dto.topic ?? course.name,
        memo: dto.memo,
        color: dto.color ?? course.color,
      });
      if (actorId != null)
        this.audit.log({ entity: SESSIONS, entityId: created.id, action: 'create', actorId, changes: this.audit.snapshotOf(created) as never });
      return created;
    });
    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return { row: this.enrich(row, roomsMap), conflicts };
  }

  // 세션 삭제 — [v9] soft delete(행 보존·deletedBy 기록) + audit before 스냅샷 + 동반 정리(출결·리포트) 단일 tx.
  async remove(id: number, actorId?: number): Promise<{ id: number; deleted: boolean }> {
    const before = this.db.findById<ClassSession>(SESSIONS, id);
    if (!before) throw new NotFoundException(`Session ${id} not found`);
    return this.db.transaction(() => {
      const snap = { ...before };
      const deleted = this.db.remove(SESSIONS, id, actorId);
      // 동반 soft delete(무결성·캐스케이드 — dbml v9 §33): 이 세션의 출결·리포트
      for (const a of this.db.findByField<BaseRow & { sessionId: number }>('attendance', 'sessionId', id))
        this.db.remove('attendance', a.id, actorId);
      for (const r of this.db.findByField<BaseRow & { sessionId: number }>('session_reports', 'sessionId', id))
        this.db.remove('session_reports', r.id, actorId);
      if (actorId != null)
        this.audit.log({ entity: SESSIONS, entityId: id, action: 'delete', actorId, changes: this.audit.snapshotOf(snap) as never });
      return { id, deleted };
    });
  }

  // 충돌 드라이런(생성·이동 전 검사)
  checkConflicts(input: {
    sessionDate: string; startTime: string; endTime?: string; durationMinutes?: number;
    instructorId?: number; roomId?: number; ignoreSessionId?: number;
  }): Conflict[] {
    // [R-9] endTime/durationMinutes를 그대로 전달 — conflict.util이 자정 크로스(익일 종료)까지 해석.
    return detectConflicts(
      { sessionDate: input.sessionDate, startTime: input.startTime, endTime: input.endTime, durationMinutes: input.durationMinutes, instructorId: input.instructorId, roomId: input.roomId, ignoreSessionId: input.ignoreSessionId },
      this.db.findAll<ClassSession>(SESSIONS),
      this.availability.list(),
    );
  }

  // 이동·리사이즈·상세편집. 충돌 시(force 아니면) 409 + conflicts 반환.
  // scope(this_and_following|all)면 같은 seriesId 세션에 동일 날짜·시간 델타를 함께 적용.
  async update(id: number, dto: UpdateScheduleDto, actorId?: number): Promise<{ row: ScheduleRow; conflicts: Conflict[]; updated: number }> {
    // [명시 코호트 v0.1.13] 부분집합 검증 — create와 동일 규칙(함수 통일: activeStudentIds 단일 소스)
    if (dto.studentIds?.length) {
      const cur0 = this.db.findById<ClassSession>(SESSIONS, id);
      const allowed = new Set(this.activeStudentIds(dto.courseId ?? cur0?.courseId ?? 0));
      const bad = dto.studentIds.filter((x) => !allowed.has(x));
      if (bad.length) throw new BadRequestException(`이 코스의 활성 수강생이 아닙니다: studentId ${bad.join(', ')}`);
    }
    // [원자성] 반복 시리즈 scope 편집 — 대상+동반 세션이 전부 반영되거나 전부 롤백(부분 편집 잔존 금지)
    return this.db.transaction(() => {
    const cur = this.db.findById<ClassSession>(SESSIONS, id);
    if (!cur) throw new NotFoundException(`Session ${id} not found`);

    // 참조 무결성(FK) 검증
    if (dto.courseId != null && !this.courseOf(dto.courseId)) throw new BadRequestException(`courseId ${dto.courseId} 없음`);
    if (dto.instructorId != null && !this.isInstructor(dto.instructorId)) throw new BadRequestException(`instructorId ${dto.instructorId} 없음`);
    if (dto.roomId != null && !this.rooms.findAll().some((r) => r.id === dto.roomId)) throw new BadRequestException(`roomId ${dto.roomId} 없음`);

    // 1) 대상(primary) 세션의 새 필드 계산
    const primary = this.mergeFields(cur, dto);

    // 2) 시리즈 동반 편집 대상 산출(this=대상만, this_and_following=대상 이후, all=시리즈 전체)
    //    공통 델타: 날짜(일수)·시작시각(분). 강의실/강사/상태/시수는 절대값으로 동일 적용.
    const scope = dto.scope ?? 'this';
    const dayDelta = dayDiff(primary.sessionDate, cur.sessionDate);
    const startDelta = toMin(primary.startTime) - toMin(cur.startTime ?? primary.startTime);
    const seriesPatches: { id: number; fields: MergedFields }[] = [];
    if (scope !== 'this' && cur.seriesId != null) {
      const members = this.db.findBy<ClassSession>(SESSIONS, (s) =>
        s.id !== id && s.seriesId === cur.seriesId &&
        (scope === 'all' || s.sessionDate > cur.sessionDate),
      );
      for (const m of members) {
        const mStart = addMinutes(m.startTime ?? '00:00', startDelta);
        seriesPatches.push({
          id: m.id,
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
    }

    // 3) 충돌 검사(대상 + 시리즈 동반). 자기 자신과 함께 이동하는 형제는 검사에서 제외.
    const movingIds = new Set<number>([id, ...seriesPatches.map((p) => p.id)]);
    const others = this.db.findBy<ClassSession>(SESSIONS, (s) => !movingIds.has(s.id));
    const blocks = this.availability.list();
    const conflicts: Conflict[] = [];
    for (const f of [primary, ...seriesPatches.map((p) => p.fields)]) {
      conflicts.push(...detectConflicts(
        // [R-9] 크로스 세션은 endTime이 undefined — durationMinutes로 이틀(±1일) 겹침 검사
        { sessionDate: f.sessionDate, startTime: f.startTime, endTime: f.endTime, durationMinutes: f.durationMinutes, instructorId: f.instructorId, roomId: f.roomId },
        others, blocks,
      ));
    }
    // 결강·취소(canceled/no_show)로 바꾸는 변경은 시간 점유가 사라지므로 충돌 검사와 무관 — 항상 허용.
    const becomesCanceled = primary.status === 'canceled' || primary.status === 'no_show';
    if (conflicts.length && !dto.force && !becomesCanceled) {
      this.logger.warn(`update 충돌 ${conflicts.length}건 — session=${id} scope=${scope} (force로 강제 가능)`);
      throw new ConflictException({ message: '스케줄 충돌', conflicts });
    }

    // 4) 일괄 적용(대상 먼저, 그 뒤 시리즈)
    const beforeSnap = { ...cur }; // audit diff용(적용 전 상태 — cur는 라이브 행이라 사본 필수)
    const updated = this.db.update<ClassSession>(SESSIONS, id, primary)!;
    for (const p of seriesPatches) this.db.update<ClassSession>(SESSIONS, p.id, p.fields);
    if (actorId != null) {
      const diff = this.audit.diffOf(beforeSnap, updated);
      if (Object.keys(diff).length)
        this.audit.log({ entity: SESSIONS, entityId: id, action: 'update', actorId, changes: diff }); // 시리즈 동반은 대상 1건으로 대표(scope는 diff에 미포함)
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
    let durationMinutes: number;
    if (dto.endTime) durationMinutes = durationFrom(startTime, dto.endTime);
    else if (dto.durationMinutes != null) durationMinutes = dto.durationMinutes;
    // 종료/시수 미지정 → 시수 유지(이동 시 종료는 시작 기준 재파생 — 크로스 여부도 재판정).
    else durationMinutes = cur.durationMinutes;
    assertDuration(startTime, durationMinutes);
    const endTime = endTimeOf(startTime, durationMinutes);

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
      instructorAttendance: dto.clearInstructorAttendance ? undefined : (dto.instructorAttendance ?? cur.instructorAttendance),
      studentIds: dto.studentIds ?? cur.studentIds, // 명시 코호트(v0.1.13) — 검증은 update() 본문
      kind: dto.kind ?? cur.kind ?? SESSION_DEFAULTS.kind, // [v0.1.14]
      mode: dto.mode ?? cur.mode ?? SESSION_DEFAULTS.mode, // [v0.1.16]
      price: dto.price ?? cur.price,
    };
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
      // [R-9] 자정 크로스(시작+진행≥24:00)면 endTime 미제공 — FE가 durationMinutes로 파생(단일 규칙)
      endTime: s.endTime ?? (s.startTime ? endTimeOf(s.startTime, s.durationMinutes) : undefined),
      courseName: c?.name ?? `course ${s.courseId}`,
      subjectName: this.subjectOf(c?.subjectId)?.name ?? '',
      instructorName: this.instructorName(s.instructorId) ?? `강사 ${s.instructorId}`,
      roomName: s.roomId ? rooms.get(s.roomId)?.name : undefined,
      color: s.color ?? c?.color ?? (c ? SUBJECT_FALLBACK_COLOR[c.subjectId] : undefined), // 세션 → 코스 → 과목 폴백
      studentIds,
      studentNames: studentIds.map((sid) => this.studentOf(sid)?.name ?? `학생 ${sid}`),
    };
  }
}
