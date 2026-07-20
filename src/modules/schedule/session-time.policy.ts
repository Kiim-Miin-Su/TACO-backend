// [TBO-29C C4] 세션 시간(start/end/duration) 정규화의 **단일 소스** — create/series/merge(update)/
//  request/approval 경로가 전부 이 함수를 지나며, 경로별 `durationMinutes ?? 60` 사본을 폐기한다.
//
//  규칙([R-9] 자정 크로스 정식 지원 승계):
//  · endTime < startTime = 익일 종료(+1440 래핑). 같으면 400.
//  · 종료가 24:00 이상(자정 크로스)이면 endTime을 저장하지 않는다 — **명시 null**('25:00' 금지,
//    durationMinutes 파생이 단일 진실). undefined가 아니라 null인 이유: PG UPDATE payload는 undefined를
//    skip해 이전 end_time이 잔존했다(메모리/PG 투영 편차 — C0 기준선 발견 ①②의 근본 원인).
//  · duration 하한 10분·상한 480분(자정 크로스 포함) — DTO·요청 경로와 동일 계약을 한 곳에서 강제.
import { BadRequestException } from '@nestjs/common';
import { durationMinutesBetween, hhmmToMin, minToHhmm } from '../../common/time.util';

export const SESSION_TIME_DEFAULTS = { durationMinutes: 60 } as const;
export const SESSION_MIN_MIN = 10;
export const SESSION_MAX_MIN = 480;

export type NormalizedSessionTime = {
  startTime: string;
  durationMinutes: number;
  /** 24:00 미만 종료 = 'HH:mm' · 자정 크로스 = null(명시 저장 — duration 파생) */
  endTime: string | null;
};

/** 가드형 addMinutes — 자정 범위를 벗어나면 400(시리즈 델타 등 시작시각 계산용). */
export function addMinutesGuarded(hhmm: string, mins: number): string {
  const t = hhmmToMin(hhmm) + mins;
  if (t < 0 || t >= 24 * 60) throw new BadRequestException(`시간 범위를 벗어납니다(${hhmm} ${mins >= 0 ? '+' : ''}${mins}분)`);
  return minToHhmm(t);
}

/** 저장/응답용 endTime — 자정(24:00) 이상 종료면 **null**(durationMinutes 파생 규칙). */
export function storedEndTimeOf(startTime: string, durationMinutes: number): string | null {
  return hhmmToMin(startTime) + durationMinutes >= 24 * 60 ? null : addMinutesGuarded(startTime, durationMinutes);
}

/** duration 검증 — 0 이하/10분 미만/480분 초과 = 400(자정 크로스 포함 공통 상한). */
export function assertSessionDuration(_startTime: string, durationMinutes: number): void {
  if (durationMinutes <= 0) throw new BadRequestException('종료 시각이 시작과 같을 수 없습니다');
  if (durationMinutes < SESSION_MIN_MIN || durationMinutes > SESSION_MAX_MIN)
    throw new BadRequestException(`수업 진행시간은 ${SESSION_MIN_MIN}분 이상 ${SESSION_MAX_MIN}분 이하여야 합니다.`);
}

/** 시간 정규화 단일 진입점. defaultDurationMinutes: 미지정 시 기본(생성=60 · 병합=기존 시수 유지). */
export function normalizeSessionTime(
  input: { startTime: string; endTime?: string | null; durationMinutes?: number | null },
  opts?: { defaultDurationMinutes?: number },
): NormalizedSessionTime {
  const durationMinutes = input.endTime
    ? durationMinutesBetween(input.startTime, input.endTime)
    : input.durationMinutes ?? opts?.defaultDurationMinutes ?? SESSION_TIME_DEFAULTS.durationMinutes;
  assertSessionDuration(input.startTime, durationMinutes);
  return { startTime: input.startTime, durationMinutes, endTime: storedEndTimeOf(input.startTime, durationMinutes) };
}
