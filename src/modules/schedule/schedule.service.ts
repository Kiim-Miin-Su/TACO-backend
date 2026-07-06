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

// [감사 A, 2026-07-02] 하드코딩 상수(STUDENTS_LBL/COURSE_STUDENTS/COURSES/SUBJECTS) 제거 —
//  코호트·카탈로그는 실제 컬렉션(students/enrollments/courses/subjects)을 조회한다(단일 소스).
//  이전엔 상수 + `status !== 'drop'`(존재하지 않는 상태값 — 실제 소프트삭제는 'canceled') 필터라
//  학생 삭제·신규 수강이 캘린더에 반영되지 않는 무결성 버그가 있었다.
// 강사만 상수 유지: users 시드와 스케줄 instructorId(1,2)의 식별자 정합이 아직 안 돼 있어(TBO-06 잔여)
//  users 컬렉션으로 바꾸면 FK가 어긋난다. JWT/users 정합 후 교체할 것.
const INSTRUCTORS: Record<number, string> = { 1: '박지훈', 2: '정유진' };
// 과목 색 폴백(표시용) — Subject 계약에 color가 없어 세션→코스 색이 모두 없을 때만 사용.
const SUBJECT_FALLBACK_COLOR: Record<number, string> = { 1: '#0969da', 2: '#1a7f37' };

// ── 날짜/시간 유틸(결정론적, KST 의존 없음) ──
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const weekdayOf = (dateStr: string) => new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0(일)~6(토)
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  // [M3] 시리즈 델타 적용 시 자정 범위를 벗어나면 '0-4:-30' 같은 오염 문자열이 커밋될 수 있음(코드리뷰).
  //  여기서 400을 던지면 감싼 db.transaction이 시리즈 전체를 롤백한다(부분 오염 금지).
  if (t < 0 || t >= 24 * 60) throw new BadRequestException(`시간 범위를 벗어납니다(${hhmm} ${mins >= 0 ? '+' : ''}${mins}분)`);
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}
const addDaysISO = (dateStr: string, days: number): string => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
};
const dayDiff = (a: string, b: string): number =>
  Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000);
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
type SeedSeries = { courseId: number; instructorId: number; topic: string; roomId: number; weekdayOffsets: number[]; startTime: string; durationMinutes: number };
// 병합된 세션 필드(업데이트 적용 단위) — 이동/리사이즈/편집 공통.
type MergedFields = {
  studentIds?: number[]; // 명시 코호트(v0.1.13)
  sessionDate: string; startTime: string; endTime: string; durationMinutes: number;
  courseId: number; instructorId: number; roomId?: number; status: ClassSession['status']; topic?: string; memo?: string; color?: string;
  instructorAttendance?: ClassSession['instructorAttendance'];
  kind?: ClassSession['kind']; price?: number; // [v0.1.14]
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
      // TOEFL 정규(강사1·강의실2) — 월·수 18:00
      { courseId: 12, instructorId: 1, topic: 'TOEFL 정규', roomId: 2, weekdayOffsets: [0, 2], startTime: '18:00', durationMinutes: 90 },
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
      status: 'scheduled', topic: 'TOEFL 정규 — 보강',
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
      instructors: Object.entries(INSTRUCTORS).map(([id, name]) => {
        const c = courses.find((x) => x.instructorId === Number(id));
        return {
          type: 'instructor' as const, id: Number(id), name,
          color: PALETTE[Number(id) % PALETTE.length],
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
        instructorName: INSTRUCTORS[c.instructorId],
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
    if (!INSTRUCTORS[instructorId]) throw new BadRequestException(`instructorId ${instructorId} 없음`);
    if (input.roomId != null && !this.rooms.findAll().some((r) => r.id === input.roomId))
      throw new BadRequestException(`roomId ${input.roomId} 없음`);
    if (input.studentIds?.length) {
      const allowed = new Set(this.activeStudentIds(input.courseId));
      const bad = input.studentIds.filter((id) => !allowed.has(id));
      if (bad.length) throw new BadRequestException(`이 코스의 활성 수강생이 아닙니다: studentId ${bad.join(', ')}`);
    }
    return instructorId;
  }

  create(dto: {
    courseId: number; instructorId?: number; roomId?: number; sessionDate: string;
    startTime: string; endTime?: string; durationMinutes?: number; topic?: string; memo?: string; color?: string;
    studentIds?: number[]; // 명시 코호트(v0.1.13)
    seriesId?: number; status?: ClassSession['status']; force?: boolean;
    kind?: ClassSession['kind']; price?: number; // [v0.1.14] 종류·세션 단건 가격
  }, actorId?: number): { row: ScheduleRow; conflicts: Conflict[] } {
    const instructorId = this.validateSessionInput(dto); // FK·코호트 공통 검증(함수 통일)
    const course = this.courseOf(dto.courseId)!;

    const startTime = dto.startTime;
    const durationMinutes = dto.endTime
      ? toMin(dto.endTime) - toMin(startTime)
      : dto.durationMinutes ?? 60;
    if (durationMinutes <= 0) throw new BadRequestException('종료 시각이 시작보다 빠릅니다');
    const endTime = dto.endTime ?? addMinutes(startTime, durationMinutes);

    const conflicts = detectConflicts(
      { sessionDate: dto.sessionDate, startTime, endTime, instructorId, roomId: dto.roomId },
      this.db.findAll<ClassSession>(SESSIONS),
      this.availability.list(),
    );
    // 디버깅: 생성 요청 + 충돌 현황 로깅
    if (conflicts.length && !dto.force) {
      this.logger.warn(`create 충돌 ${conflicts.length}건 — course=${dto.courseId} ${dto.sessionDate} ${dto.startTime} (force로 강제 가능)`);
      throw new ConflictException({ message: '스케줄 충돌', conflicts });
    }

    // [원자성] 세션 생성 + 변경 이력(audit)이 함께 반영되거나 함께 롤백
    const row = this.db.transaction(() => {
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
        status: dto.status ?? 'scheduled',
        kind: dto.kind ?? 'class', // [v0.1.14] 기본 class(하위호환)
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
  remove(id: number, actorId?: number): { id: number; deleted: boolean } {
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
    const endTime = input.endTime ?? (input.durationMinutes != null ? addMinutes(input.startTime, input.durationMinutes) : input.startTime);
    return detectConflicts(
      { sessionDate: input.sessionDate, startTime: input.startTime, endTime, instructorId: input.instructorId, roomId: input.roomId, ignoreSessionId: input.ignoreSessionId },
      this.db.findAll<ClassSession>(SESSIONS),
      this.availability.list(),
    );
  }

  // 이동·리사이즈·상세편집. 충돌 시(force 아니면) 409 + conflicts 반환.
  // scope(this_and_following|all)면 같은 seriesId 세션에 동일 날짜·시간 델타를 함께 적용.
  update(id: number, dto: UpdateScheduleDto, actorId?: number): { row: ScheduleRow; conflicts: Conflict[]; updated: number } {
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
    if (dto.instructorId != null && !INSTRUCTORS[dto.instructorId]) throw new BadRequestException(`instructorId ${dto.instructorId} 없음`);
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
            endTime: addMinutes(mStart, primary.durationMinutes),
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
        { sessionDate: f.sessionDate, startTime: f.startTime, endTime: f.endTime, instructorId: f.instructorId, roomId: f.roomId },
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
    let endTime: string;
    let durationMinutes: number;
    if (dto.endTime) { endTime = dto.endTime; durationMinutes = toMin(endTime) - toMin(startTime); }
    // [R-1b 2026-07-06] F4 확인: durationMinutes 경로(드래그 이동 = {startTime, durationMinutes} 패치)의
    //  자정 초과(예: 23:30+90분='25:00')는 **이 파일 로컬 addMinutes의 [M3] 가드**가 400을 던져 저장 전에
    //  차단된다(리뷰가 지목한 conflict.util.addMinutes는 겹침 파생 전용 — 저장 경로에서 미사용).
    //  dto.endTime 경로는 DTO HHMM 정규식(2[0-3])이 24시 이상을 차단. e2e 회귀: schedule.e2e-spec F4 케이스.
    else if (dto.durationMinutes != null) { durationMinutes = dto.durationMinutes; endTime = addMinutes(startTime, durationMinutes); }
    // 종료/시수 미지정 → 시수 유지하되 종료는 시작 기준으로 재계산(이동 시 종료가 어긋나지 않게).
    else { durationMinutes = cur.durationMinutes; endTime = addMinutes(startTime, durationMinutes); }
    if (durationMinutes <= 0) throw new BadRequestException('종료 시각이 시작보다 빠릅니다');

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
      instructorAttendance: dto.instructorAttendance ?? cur.instructorAttendance,
      studentIds: dto.studentIds ?? cur.studentIds, // 명시 코호트(v0.1.13) — 검증은 update() 본문
      kind: dto.kind ?? cur.kind ?? 'class', // [v0.1.14]
      price: dto.price ?? cur.price,
    };
  }

  private enrich(s: ClassSession, rooms: Map<number, { name: string }>): ScheduleRow {
    const c = this.courseOf(s.courseId);
    // 명시 코호트(v0.1.13) 우선 — 미지정 시 기존대로 코스 활성 수강생 파생(하위 호환)
    const studentIds = s.studentIds?.length ? s.studentIds.map(Number) : this.activeStudentIds(s.courseId);
    return {
      ...s,
      kind: s.kind ?? 'class', // [v0.1.14] 시드·구데이터 하위호환(미지정=class)
      weekday: weekdayOf(s.sessionDate),
      endTime: s.endTime ?? (s.startTime ? addMinutes(s.startTime, s.durationMinutes) : undefined),
      courseName: c?.name ?? `course ${s.courseId}`,
      subjectName: this.subjectOf(c?.subjectId)?.name ?? '',
      instructorName: INSTRUCTORS[s.instructorId] ?? `강사 ${s.instructorId}`,
      roomName: s.roomId ? rooms.get(s.roomId)?.name : undefined,
      color: s.color ?? c?.color ?? (c ? SUBJECT_FALLBACK_COLOR[c.subjectId] : undefined), // 세션 → 코스 → 과목 폴백
      studentIds,
      studentNames: studentIds.map((sid) => this.studentOf(sid)?.name ?? `학생 ${sid}`),
    };
  }
}
