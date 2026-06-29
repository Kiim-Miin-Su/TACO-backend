import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ScheduleRow } from '@kms545487/contracts';
import { InMemoryDatabase } from '../../database/in-memory.database';
import { RoomsService } from '../rooms/rooms.service';
import { ClassSession, SESSIONS } from './schedule.entity';

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
