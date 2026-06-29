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
const COURSES: Record<number, { name: string; subjectId: number; instructorId: number }> = {
  10: { name: 'SAT Reading 정규', subjectId: 1, instructorId: 1 },
  11: { name: 'AP Calculus BC', subjectId: 2, instructorId: 2 },
  12: { name: 'TOEFL 정규', subjectId: 1, instructorId: 1 },
};

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
function mondayOfThisWeekUTC(): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=일
  const diff = dow === 0 ? -6 : 1 - dow; // 월요일로 이동
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

type SeedDef = { dayOffset: number; startTime: string; durationMinutes: number; courseId: number; roomId: number; status: ClassSession['status'] };

@Injectable()
export class ScheduleService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly rooms: RoomsService,
    private readonly availability: AvailabilityService,
  ) {}

  // 이번 주(월~금) 데모 수업 시드. 강의실/강사/시간 충돌 없게 구성.
  onModuleInit(): void {
    if (this.db.findAll<ClassSession>(SESSIONS).length) return;
    const mon = mondayOfThisWeekUTC();
    const defs: SeedDef[] = [
      { dayOffset: 0, startTime: '16:00', durationMinutes: 90, courseId: 10, roomId: 1, status: 'scheduled' },
      { dayOffset: 0, startTime: '18:00', durationMinutes: 90, courseId: 11, roomId: 2, status: 'scheduled' },
      { dayOffset: 1, startTime: '16:00', durationMinutes: 90, courseId: 12, roomId: 1, status: 'scheduled' },
      { dayOffset: 1, startTime: '16:00', durationMinutes: 120, courseId: 11, roomId: 3, status: 'scheduled' },
      { dayOffset: 2, startTime: '16:00', durationMinutes: 90, courseId: 10, roomId: 1, status: 'scheduled' },
      { dayOffset: 2, startTime: '18:00', durationMinutes: 90, courseId: 12, roomId: 2, status: 'scheduled' },
      { dayOffset: 3, startTime: '16:00', durationMinutes: 120, courseId: 11, roomId: 3, status: 'scheduled' },
      { dayOffset: 4, startTime: '16:00', durationMinutes: 90, courseId: 10, roomId: 1, status: 'scheduled' },
      { dayOffset: 4, startTime: '18:00', durationMinutes: 90, courseId: 12, roomId: 2, status: 'scheduled' },
    ];
    let series = 0;
    defs.forEach((d) => {
      const c = COURSES[d.courseId];
      const date = new Date(mon);
      date.setUTCDate(date.getUTCDate() + d.dayOffset);
      this.db.insert<ClassSession>(SESSIONS, {
        seriesId: ++series,
        courseId: d.courseId,
        instructorId: c.instructorId,
        roomId: d.roomId,
        sessionDate: fmt(date),
        startTime: d.startTime,
        endTime: addMinutes(d.startTime, d.durationMinutes),
        durationMinutes: d.durationMinutes,
        status: d.status,
        topic: c.name,
      });
    });
  }

  // 기간/필터 조회 → enriched 읽기모델(주간 표용)
  list(opts: { from?: string; to?: string; instructorId?: number; roomId?: number }): ScheduleRow[] {
    const rooms = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return this.db
      .findBy<ClassSession>(SESSIONS, (s) =>
        (opts.from ? s.sessionDate >= opts.from : true) &&
        (opts.to ? s.sessionDate <= opts.to : true) &&
        (opts.instructorId ? s.instructorId === opts.instructorId : true) &&
        (opts.roomId ? s.roomId === opts.roomId : true),
      )
      .map((s) => this.enrich(s, rooms))
      .sort((a, b) => (a.sessionDate + (a.startTime ?? '')).localeCompare(b.sessionDate + (b.startTime ?? '')));
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
  update(id: number, dto: UpdateScheduleDto): { row: ScheduleRow; conflicts: Conflict[] } {
    const cur = this.db.findById<ClassSession>(SESSIONS, id);
    if (!cur) throw new NotFoundException(`Session ${id} not found`);

    // 참조 무결성(FK) 검증
    if (dto.courseId != null && !COURSES[dto.courseId]) throw new BadRequestException(`courseId ${dto.courseId} 없음`);
    if (dto.instructorId != null && !INSTRUCTORS[dto.instructorId]) throw new BadRequestException(`instructorId ${dto.instructorId} 없음`);
    if (dto.roomId != null && !this.rooms.findAll().some((r) => r.id === dto.roomId)) throw new BadRequestException(`roomId ${dto.roomId} 없음`);

    // 필드 병합(이동=날짜/시간, 리사이즈=종료/시수, 편집=코스/강사/강의실/상태)
    const sessionDate = dto.sessionDate ?? cur.sessionDate;
    const startTime = dto.startTime ?? cur.startTime ?? '00:00';
    let endTime: string;
    let durationMinutes: number;
    if (dto.endTime) { endTime = dto.endTime; durationMinutes = toMin(endTime) - toMin(startTime); }
    else if (dto.durationMinutes != null) { durationMinutes = dto.durationMinutes; endTime = addMinutes(startTime, durationMinutes); }
    else { durationMinutes = cur.durationMinutes; endTime = cur.endTime ?? addMinutes(startTime, durationMinutes); }
    if (durationMinutes <= 0) throw new BadRequestException('종료 시각이 시작보다 빠릅니다');

    const courseId = dto.courseId ?? cur.courseId;
    const course = COURSES[courseId];
    const instructorId = dto.instructorId ?? (dto.courseId != null && course ? course.instructorId : cur.instructorId);
    const roomId = dto.roomId ?? cur.roomId;

    const conflicts = detectConflicts(
      { sessionDate, startTime, endTime, instructorId, roomId, ignoreSessionId: id },
      this.db.findAll<ClassSession>(SESSIONS),
      this.availability.list(),
    );
    if (conflicts.length && !dto.force) throw new ConflictException({ message: '스케줄 충돌', conflicts });

    const updated = this.db.update<ClassSession>(SESSIONS, id, {
      sessionDate, startTime, endTime, durationMinutes, courseId, instructorId, roomId,
      status: dto.status ?? cur.status,
      topic: dto.topic ?? (dto.courseId != null && course ? course.name : cur.topic),
    })!;
    const roomsMap = new Map(this.rooms.findAll().map((r) => [r.id, r]));
    return { row: this.enrich(updated, roomsMap), conflicts };
  }

  private enrich(s: ClassSession, rooms: Map<number, { name: string }>): ScheduleRow {
    const c = COURSES[s.courseId];
    const sub = c ? SUBJECTS[c.subjectId] : undefined;
    return {
      ...s,
      weekday: weekdayOf(s.sessionDate),
      endTime: s.endTime ?? (s.startTime ? addMinutes(s.startTime, s.durationMinutes) : undefined),
      courseName: c?.name ?? `course ${s.courseId}`,
      subjectName: sub?.name ?? '',
      instructorName: INSTRUCTORS[s.instructorId] ?? `강사 ${s.instructorId}`,
      roomName: s.roomId ? rooms.get(s.roomId)?.name : undefined,
      color: sub?.color,
    };
  }
}
