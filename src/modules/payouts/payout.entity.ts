import type { BaseRow } from '../../common/types/base';

export const PAYOUTS = 'instructor_payouts';
export const TRANSACTIONS = 'transactions';

/**
 * 정산서 상태.
 *  pending   — 산정 완료(승인 대기)
 *  confirmed — 관리자 확정
 *  paid      — 지급 완료(통합 원장에 출금 기록)
 *  rejected  — 반려(연결 세션 회수 → 재산정 가능)  ※ 계약 PayoutStatus 확장
 */
export type PayoutStatus = 'pending' | 'confirmed' | 'paid' | 'rejected';

// 정산서에 묶인 세션 1건의 산정 명세(감사 추적용 스냅샷).
export type PayoutLine = {
  sessionId: number;
  courseId: number;
  courseName: string;
  sessionDate: string;
  durationMinutes: number; // 시수(분)
  hourlyRate: number; // 코스 조인 시급(원/시간) 스냅샷
  amount: number; // round(분/60 × 시급)
};

export type InstructorPayoutRow = {
  instructorId: number; // FK → 강사
  periodStart: string;
  periodEnd: string;
  sessionCount: number; // 정산 대상 세션 수
  totalMinutes: number; // 총 시수(분)
  computedAmount: number; // 시수×시급 자동 산정액(불변 기준)
  adjustedAmount?: number; // 관리자 급여 수정액(있으면 우선)
  adjustReason?: string;
  amount: number; // 실효 지급액 = adjustedAmount ?? computedAmount
  status: PayoutStatus;
  lines: PayoutLine[]; // 산정 명세(세션별)
  rejectedReason?: string;
  paidAt?: string;
  confirmedAt?: string;
} & BaseRow;

// 통합 원장(출금) 기록 — 지급 확정 시 1줄.
export type TransactionRow = {
  direction: 'in' | 'out';
  category: string;
  label: string;
  amount: number;
  occurredAt: string;
  payoutId?: number;
} & BaseRow;
