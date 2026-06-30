import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { Conflict, ScheduleRow } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { RoomsService } from '../rooms/rooms.service';
import { AvailabilityService } from '../availability/availability.service';
import { ClassSession, SESSIONS } from './schedule.entity';
import { detectConflicts } from './conflict.util';
import { UpdateScheduleDto } from './dto/update-schedule.dto';

// in-module 라벨 룩업(데모) — 프론트 mock seed와 정렬.
const INSTRUCTORS: Record<number, string> = { 1: '박지훈', 2: '정유진' };
const SUBJECTS: Record<number, { name: string; color: string }> = {
  1: { name: '영어', color: '#0969da' },
  2: { name: '수학', color: '#1a7f37' },
};
// color = 개설 시 선택한 캘린더 색상 라벨(코스 단위). 세션 색 기본값.
const COURSES: Record<number, { name: string; subjectId: number; instructorId: number; color: string }> = {
  10: { name: 'SAT Reading 정규', subjectId: 1, instructorId: 1, color: '#0969da' },
  11: { name: 'AP Calculus BC', subjectId: 2, instructorId: 2, color: '#8250df' },
  12: { name: 'TOEFL 정규', subjectId: 1, instructorId: 1, color: '#1b7c83' },
};
// 학생(데모) — 프론트 mock seed와 정렬. status==='drop'은 코호트에서 제외(소프트삭제 보존).
const STUDENTS_LBL: Record<number, { name: string; grade?: number; status: string }> = {
  1: { name: '김서연', grade: 11, status: 'active' },
  2: { name: '이준호', grade: 12, status: 'active' },
  3: { name: '박지민', grade: 10, status: 'paused' },
  4: { name: '최민준', grade: 11, status: 'active' },
};
// 코스 코호트(수강생). enrollments seed와 정렬: 10→[1,4], 11→[2], 12→[1].
const COURSE_STUDENTS: Record<number, number[]> = {
  10: [1, 4],
  11: [2],
  12: [1],
};
// 활성(비-drop) 수강생만 — 학생 차원/필터/개인 스케줄 스코프.
const activeStudentsOf = (courseId: number): number[] =>
  (COURSE_STUDENTS[courseId] ?? []).filter((sid) => STUDENTS_LBL[sid] && STUDENTS_LBL[sid].status !== 'drop');

// ── 날짜/시간 유틸(결정론적, KST 의존 없음) ──
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const weekdayOf = (dateStr: string) => new Date(dateStr + 'T00:00:00Z').getUTCDay(); // 0(일)~6(토)
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
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
type SeedSeries = { courseId: number; roomId: number; weekdayOffsets: number[]; startTime: string; durationMinutes: number };
// 병합된 세션 필드(업데이트 적용 단위) — 이동/리사이즈/편집 공통.
type MergedFields = {
  sessionDate: string; startTime: string; endTime: string; durationMinutes: number;
  courseId: number; instructorId: number; roomId?: number; status: ClassSession['status']; topic?: string; memo?: string; color?: string;
};

@Injectable()
export class ScheduleService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly rooms: RoomsService,
    private readonly availability: AvailabilityService,
  ) {}

  // 이번 주 데모 수업 시드 — 주간 반복 시리즈 단위(같은 시리즈=한 seriesId). 충돌 없게 구성.
  onModuleInit(): void {
    if (this.db.findAll<ClassSession>(SESSIONS).length) return;
    const mon = mondayOfThisWeekUTC();
    const series: SeedSeries[] = [
      // SAT Reading 정규(강사1·강의실1) — 월·수·금 16:00
      { courseId: 10, roomId: 1, weekdayOffsets: [0, 2, 4], startTime: '16:00', durationMinutes: 90 },
      // AP Calculus BC(강사2·강의실3) — 화·목 16:00
      { courseId: 11, roomId: 3, weekdayOffsets: [1, 3], startTime: '16:00', durationMinutes: 120 },
      // TOEFL 정규(강사1·강의실2) — 월·수 18:00
      { courseId: 12, roomId: 2, weekdayOffsets: [0, 2], startTime: '18:00', durationMinutes: 90 },
    ];
    let seriesId = 0;
    series.forEach((sr) => {
      const sid = ++seriesId;
      const c = COURSES[sr.courseId];
      sr.weekdayOffsets.forEach((off) => {
        const date = new Date(mon);
        date.setUTCDate(date.getUTCDate() + off);
        this.db.insert<ClassSession>(SESSIONS, {
          seriesId: sid,
          courseId: sr.courseId,
          instructorId: c.instructorId,
          roomId: sr.roomId,
          sessionDate: fmt(date),
          startTime: sr.startTime,
          endTime: addMinutes(sr.startTime, sr.durationMinutes),
          durationMinutes: sr.durationMinutes,
          status: 'scheduled',
          topic: c.name,
        });
      });
    });

    // 테스트용 겹침 픽스처: 강사1(박지훈)의 점심 불가시간(월 12:00–13:00) 위에 놓인 세션.
    // 캘린더에서 강사1 선택 시 회색 불가 밴드와 겹치는 수업이 보이고, 충돌 검사 데모가 가능.
    const mon0 = fmt(mon);
    this.db.insert<ClassSession>(SESSIONS, {
      courseId: 12, instructorId: 1, roomId: 2,
      sessionDate: mon0, startTime: '12:30', endTime: '13:30', durationMinutes: 60,
      status: 'scheduled', topic: 'TOEFL 보강(불가시간 겹침 데모)',
      memo: '⚠ 강사1 점심(12:00–13:00)과 겹침 — 충돌 시각화 테스트용',
    });
  }

  // 기간/필터 조회 → enriched 읽기모델(주간 표/캘린더용)
  // studentId 필터: 해당 학생이 활성 수강 중인 코스의 세션만(코호트 역추적).
  list(opts: { from?: string; to?: string; instructorId?: number; roomId?: number; studentId?: number }): ScheduleRow[] {
    const rooms = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    const coursesOfStudent = opts.studentId != null
      ? new Set(Object.keys(COURSE_STUDENTS).map(Number).filter((cid) => activeStudentsOf(cid).includes(opts.studentId!)))
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
    return {
      instructors: Object.entries(INSTRUCTORS).map(([id, name]) => ({
        type: 'instructor' as const, id: Number(id), name,
        color: PALETTE[Number(id) % PALETTE.length],
        sub: Object.values(COURSES).find((c) => c.instructorId === Number(id))
          ? SUBJECTS[Object.values(COURSES).find((c) => c.instructorId === Number(id))!.subjectId]?.name
          : undefined,
      })),
      rooms: this.rooms.findAll().map((r) => ({
        type: 'room' as const, id: r.id, name: r.name, color: r.color,
        sub: r.capacity != null ? `정원 ${r.capacity}` : undefined,
      })),
      students: Object.entries(STUDENTS_LBL)
        .filter(([, s]) => s.status !== 'drop')
        .map(([id, s]) => ({
          type: 'student' as const, id: Number(id), name: s.name,
          color: PALETTE[(Number(id) + 2) % PALETTE.length],
          sub: s.grade != null ? `${s.grade}학년` : undefined,
        })),
      courses: Object.entries(COURSES).map(([id, c]) => ({
        id: Number(id), name: c.name, instructorId: c.instructorId,
        instructorName: INSTRUCTORS[c.instructorId],
        subjectName: SUBJECTS[c.subjectId]?.name ?? '', color: c.color ?? SUBJECTS[c.subjectId]?.color,
        durationMinutes: courseDuration(Number(id)),
      })),
    };
  }

  // 세션 생성(추천→배정). FK 검증 + 충돌 검사(force 아니면 충돌 시 409).
  create(dto: {
    courseId: number; instructorId?: number; roomId?: number; sessionDate: string;
    startTime: string; endTime?: string; durationMinutes?: number; topic?: string; memo?: string; color?: string;
    seriesId?: number; status?: ClassSession['status']; force?: boolean;
  }): { row: ScheduleRow; conflicts: Conflict[] } {
    const course = COURSES[dto.courseId];
    if (!course) throw new BadRequestException(`courseId ${dto.courseId} 없음`);
    const instructorId = dto.instructorId ?? course.instructorId;
    if (!INSTRUCTORS[instructorId]) throw new BadRequestException(`instructorId ${instructorId} 없음`);
    if (dto.roomId != null && !this.rooms.findAll().some((r) => r.id === dto.roomId))
      throw new BadRequestException(`roomId ${dto.roomId} 없음`);

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
    if (conflicts.length && !dto.force) throw new ConflictException({ message: '스케줄 충돌', conflicts });

    const row = this.db.insert<ClassSession>(SESSIONS, {
      seriesId: dto.seriesId,
      courseId: dto.courseId,
      instructorId,
      roomId: dto.roomId,
      sessionDate: dto.sessionDate,
      startTime,
      endTime,
      durationMinutes,
      status: dto.status ?? 'scheduled',
      topic: dto.topic ?? course.name,
      memo: dto.memo,
      color: dto.color ?? course.color,
    });
    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return { row: this.enrich(row, roomsMap), conflicts };
  }

  // 세션 삭제. (데모: 단건 제거. 실DB에서는 출석/리포트 FK 처리 필요)
  remove(id: number): { id: number; deleted: boolean } {
    if (!this.db.findById<ClassSession>(SESSIONS, id)) throw new NotFoundException(`Session ${id} not found`);
    return { id, deleted: this.db.remove(SESSIONS, id) };
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
  update(id: number, dto: UpdateScheduleDto): { row: ScheduleRow; conflicts: Conflict[]; updated: number } {
    const cur = this.db.findById<ClassSession>(SESSIONS, id);
    if (!cur) throw new NotFoundException(`Session ${id} not found`);

    // 참조 무결성(FK) 검증
    if (dto.courseId != null && !COURSES[dto.courseId]) throw new BadRequestException(`courseId ${dto.courseId} 없음`);
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
    if (conflicts.length && !dto.force && !becomesCanceled) throw new ConflictException({ message: '스케줄 충돌', conflicts });

    // 4) 일괄 적용(대상 먼저, 그 뒤 시리즈)
    const updated = this.db.update<ClassSession>(SESSIONS, id, primary)!;
    for (const p of seriesPatches) this.db.update<ClassSession>(SESSIONS, p.id, p.fields);

    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return { row: this.enrich(updated, roomsMap), conflicts, updated: 1 + seriesPatches.length };
  }

  // 부분수정 DTO → 세션 전체 필드(이동=날짜/시간, 리사이즈=종료/시수, 편집=코스/강사/강의실/상태).
  private mergeFields(cur: ClassSession, dto: UpdateScheduleDto): MergedFields {
    const sessionDate = dto.sessionDate ?? cur.sessionDate;
    const startTime = dto.startTime ?? cur.startTime ?? '00:00';
    let endTime: string;
    let durationMinutes: number;
    if (dto.endTime) { endTime = dto.endTime; durationMinutes = toMin(endTime) - toMin(startTime); }
    else if (dto.durationMinutes != null) { durationMinutes = dto.durationMinutes; endTime = addMinutes(startTime, durationMinutes); }
    // 종료/시수 미지정 → 시수 유지하되 종료는 시작 기준으로 재계산(이동 시 종료가 어긋나지 않게).
    else { durationMinutes = cur.durationMinutes; endTime = addMinutes(startTime, durationMinutes); }
    if (durationMinutes <= 0) throw new BadRequestException('종료 시각이 시작보다 빠릅니다');

    const courseId = dto.courseId ?? cur.courseId;
    const course = COURSES[courseId];
    const instructorId = dto.instructorId ?? (dto.courseId != null && course ? course.instructorId : cur.instructorId);
    const roomId = dto.roomId ?? cur.roomId;
    return {
      sessionDate, startTime, endTime, durationMinutes, courseId, instructorId, roomId,
      status: dto.status ?? cur.status,
      topic: dto.topic ?? (dto.courseId != null && course ? course.name : cur.topic),
      memo: dto.memo ?? cur.memo,
      color: dto.color ?? cur.color,
    };
  }

  private enrich(s: ClassSession, rooms: Map<number, { name: string }>): ScheduleRow {
    const c = COURSES[s.courseId];
    const sub = c ? SUBJECTS[c.subjectId] : undefined;
    const studentIds = activeStudentsOf(s.courseId);
    return {
      ...s,
      weekday: weekdayOf(s.sessionDate),
      endTime: s.endTime ?? (s.startTime ? addMinutes(s.startTime, s.durationMinutes) : undefined),
      courseName: c?.name ?? `course ${s.courseId}`,
      subjectName: sub?.name ?? '',
      instructorName: INSTRUCTORS[s.instructorId] ?? `강사 ${s.instructorId}`,
      roomName: s.roomId ? rooms.get(s.roomId)?.name : undefined,
      color: s.color ?? c?.color ?? sub?.color, // 세션 색 → 코스 색 → 과목 색
      studentIds,
      studentNames: studentIds.map((sid) => STUDENTS_LBL[sid]?.name ?? `학생 ${sid}`),
    };
  }
}
