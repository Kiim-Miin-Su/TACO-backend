import type { BaseRow } from '../../common/types/base';

// [TBO-19 Sprint4] 강사 계약 — 월 계약 시수·계약 시급·기간. 실제 시수(payouts/attendance)와 대비해 계약 관리.
//  ⚠ 백엔드 로컬 타입(shared @kms545487/contracts 미포함 — npm 게시 불요). DB 이관(TBO-08) 시 정식 테이블로 승격.
//  강사 식별자 통일(2026-07-07): instructorId = users.id.
export type InstructorContract = {
  instructorId: number; // users.id(강사)
  monthlyHours: number; // 월 계약 시수(h)
  hourlyRate: number; // 계약 시급(원)
  periodStart: string; // 'YYYY-MM-DD'
  periodEnd?: string; // 없으면 진행 중
  active: boolean;
  memo?: string;
} & BaseRow;

export const INSTRUCTOR_CONTRACTS = 'instructor_contracts';
