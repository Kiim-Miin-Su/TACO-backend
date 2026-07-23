// [TBO-46 G1 2026-07-23] 날짜 구간(YYYY-MM-DD) 검증 단일 진실원 — counsel REST 분석과 GraphQL
//  게이트웨이가 같은 규칙을 소비한다(형식·역전 400 문구 통일).
import { BadRequestException } from '@nestjs/common';

export type DayRange = { from?: string | null; to?: string | null };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertDayRange(range: DayRange): void {
  for (const value of [range.from, range.to]) {
    if (value != null && !DAY_PATTERN.test(value)) throw new BadRequestException('기간은 YYYY-MM-DD 형식이어야 합니다.');
  }
  if (range.from && range.to && range.from > range.to) throw new BadRequestException('시작일이 종료일보다 늦을 수 없습니다.');
}

/** ISO 문자열 → YYYY-MM-DD — 분석 순수 함수들이 공유(사본 금지). */
export const dayOf = (iso: string): string => iso.slice(0, 10);
