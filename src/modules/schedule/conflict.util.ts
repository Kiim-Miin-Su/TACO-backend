// 스케줄 충돌 검사(프론트 lib/domain/schedule.ts 와 동일 규칙을 백엔드에서 재현).
// [R-9 2026-07-06] 자정 크로스 수업 정식 지원 — 세션은 1레코드(sessionDate=시작일·KST)이고 종료가
//  자정을 넘을 수 있다(저장은 endTime 미기록 → durationMinutes 파생, 입력 endTime<startTime=익일 종료).
//  겹침 검사는 "시작일 00:00 기준 절대 분(minute)" 좌표로 통일한다: 익일 종료=1440 초과,
//  인접일(±1일) 세션은 날짜 차이×1440 오프셋으로 같은 좌표계에 놓고 비교 —
//  [시작일 잔여]+[익일 00:00~] 이틀에 걸친 검사와 동치(듀레이션 상한 8h<24h라 스필은 ±1일뿐).
import type { Conflict } from '@kms545487/contracts';
import type { ClassSession } from './schedule.entity';
import type { AvailabilityBlock } from '../availability/availability.entity';
// [R-3 함수 통일] 시간·날짜 primitive는 common/time.util 단일 소스(중복 제거).
import { hhmmToMin as toMin, weekdayOf, addDaysISO, dayDiff as dayDiffDays } from '../../common/time.util';
type AvailabilityKindEx = AvailabilityBlock['kind'] | 'online_only';

/** [R-9] 종료 분(시작일 00:00 기준, 자정 크로스=1440 초과).
 *  endTime 없음 → start+duration 파생. endTime<startTime → 익일 종료(+1440)로 해석. */
export const sessionEndMin = (startTime: string, endTime: string | undefined, durationMinutes: number): number => {
  if (!endTime) return toMin(startTime) + durationMinutes;
  const e = toMin(endTime);
  const s = toMin(startTime);
  return e < s ? e + 1440 : e;
};

export type Candidate = {
  sessionDate: string;
  startTime: string;
  endTime?: string; // [R-9] endTime<startTime = 익일 종료로 해석(자정 크로스)
  durationMinutes?: number; // endTime 없을 때 종료 파생(자정 초과 허용)
  instructorId?: number;
  roomId?: number;
  studentIds?: number[];
  ignoreSessionId?: number;
  mode?: ClassSession['mode'];
};

export function detectConflicts(
  cand: Candidate,
  sessions: ClassSession[],
  blocks: AvailabilityBlock[],
  // [TBO-28C] 학생 세션 간 중복 검사용 — 기존 세션의 유효 코호트(명시 studentIds ?? 코스 활성 수강생).
  //  미전달 시 세션의 명시 studentIds만 본다(순수 함수 유지 — 호출자가 리졸버 주입).
  studentIdsOf?: (s: ClassSession) => number[],
): Conflict[] {
  const out: Conflict[] = [];
  const cS = toMin(cand.startTime);
  const cE = sessionEndMin(cand.startTime, cand.endTime, cand.durationMinutes ?? 0);
  const candStudents = (cand.studentIds ?? []).map(Number);
  // 1) 이중예약(강사·강의실·[28C]학생) — 후보 시작일 기준 절대 분 좌표 비교(±1일 세션 포함 — 자정 크로스 스필)
  for (const s of sessions) {
    if (s.id === cand.ignoreSessionId) continue;
    if (s.status === 'canceled' || s.status === 'no_show') continue; // 결강/취소는 시간 점유 아님
    if (!s.startTime) continue;
    const dd = dayDiffDays(s.sessionDate, cand.sessionDate);
    if (dd < -1 || dd > 1) continue; // 세션 상한 8h < 24h — 자정 스필은 인접 1일까지만
    const off = dd * 1440;
    const sS = off + toMin(s.startTime);
    const sE = off + sessionEndMin(s.startTime, s.endTime, s.durationMinutes);
    if (!(cS < sE && sS < cE)) continue;
    if (cand.instructorId != null && s.instructorId === cand.instructorId)
      out.push({ type: 'double_book', resource: 'instructor', resourceId: cand.instructorId, sessionId: s.id });
    if (cand.roomId != null && s.roomId === cand.roomId)
      out.push({ type: 'double_book', resource: 'room', resourceId: cand.roomId, sessionId: s.id });
    // [TBO-28C] 같은 학생이 같은 시간대 두 수업에 — 이중예약(어느 사용자/수업인지 식별 가능하게 sessionId 포함)
    if (candStudents.length) {
      const sStudents = new Set((studentIdsOf ? studentIdsOf(s) : (s.studentIds ?? [])).map(Number));
      for (const sid of candStudents) {
        if (sStudents.has(sid))
          out.push({ type: 'double_book', resource: 'student', resourceId: sid, sessionId: s.id });
      }
    }
  }
  // 2) 불가시간(Block) — 자정 크로스 후보는 [시작일 s~24:00] + [익일 00:00~잔여] 두 세그먼트로
  //    각 날짜의 요일·effective 범위에 대해 검사(블록 자체는 end<=start 400이라 항상 같은 날).
  const segs = cE > 1440
    ? [
        { date: cand.sessionDate, s: cS, e: 1440 },
        { date: addDaysISO(cand.sessionDate, 1), s: 0, e: cE - 1440 },
      ]
    : [{ date: cand.sessionDate, s: cS, e: cE }];
  for (const seg of segs) {
    const wd = weekdayOf(seg.date);
    for (const b of blocks) {
      const kind = b.kind as AvailabilityKindEx;
      if ((kind !== 'unavailable' && kind !== 'online_only') || b.weekday !== wd) continue;
      if (kind === 'online_only' && (cand.mode ?? 'in_person') === 'online') continue;
      // 기간(effectiveFrom/effectiveTo) 밖의 주에는 적용 안 함 — "이번만/앞으로/기간" 반복 규칙 반영.
      if (b.effectiveFrom && seg.date < b.effectiveFrom) continue;
      if (b.effectiveTo && seg.date > b.effectiveTo) continue;
      if (!(seg.s < toMin(b.endTime) && toMin(b.startTime) < seg.e)) continue;
      // detail: 겹친 불가시간의 실제 시각(요일·시:분)을 담아 프론트가 사람이 읽을 수 있게 표시.
      const blockDetail = kind === 'online_only' ? `온라인만 가능 ${b.startTime}–${b.endTime}` : `불가시간 ${b.startTime}–${b.endTime}`;
      if (b.ownerType === 'instructor' && cand.instructorId === b.ownerId)
        out.push({ type: 'unavailable', resource: 'instructor', resourceId: b.ownerId, detail: blockDetail });
      if (b.ownerType === 'room' && cand.roomId === b.ownerId)
        out.push({ type: 'unavailable', resource: 'room', resourceId: b.ownerId, detail: blockDetail });
      if (b.ownerType === 'student' && cand.studentIds?.includes(Number(b.ownerId)))
        out.push({ type: 'unavailable', resource: 'student', resourceId: b.ownerId, detail: blockDetail });
    }
  }
  return out;
}
