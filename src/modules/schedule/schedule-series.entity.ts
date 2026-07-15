// [TBO-29C C2] 반복 시리즈 자산 — 서버가 series ID를 발급하고 규칙·생성자·기간·version(CAS)을 영속화.
//  class_sessions.series_id가 이 표를 FK로 참조한다(마이그레이션 20260715_01에서 승격).
import type { BaseRow } from '../../database/in-memory.database';
import type { ScheduleSeriesRepeatKind } from '@kms545487/contracts';

export const CLASS_SESSION_SERIES = 'class_session_series';

export type ScheduleSeriesRow = {
  repeatKind: ScheduleSeriesRepeatKind; // weekly=시작일 요일 1개 · custom=선택 요일들
  weekdays: number[]; // 0(일)~6(토), 중복 없음
  startsOn: string; // ISO date(KST) — 첫 occurrence 후보일
  endsOn: string; // ISO date(KST) — startsOn <= endsOn
  startTime: string; // 'HH:mm' (KST)
  durationMinutes: number; // 10~480 (자정 크로스 포함 — endTime은 회차가 파생)
  timeZone: string; // 규칙 해석 기준 시간대(MVP 'Asia/Seoul')
  version: number; // series edit CAS — C3 동시 수정 감지
  createdBy?: number | null;
  updatedBy?: number | null;
} & BaseRow;
