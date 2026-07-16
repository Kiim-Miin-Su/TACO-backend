import type { BaseRow } from '../../common/types/base';

export const PAYOUTS = 'instructor_payouts';
// 통합 원장 컬렉션명은 transactions 모듈이 단일 소스(중복 상수 제거 — 자산화 점검 2026-07-02)
export { TRANSACTIONS } from '../transactions/transaction.entity';

/**
 * 정산서 상태.
 *  pending   — 산정 완료(승인 대기)
 *  confirmed — 대표 확정
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
  adjustedAmount?: number; // 대표 급여 수정액(있으면 우선)
  adjustReason?: string;
  amount: number; // 실효 지급액 = adjustedAmount ?? computedAmount
  status: PayoutStatus;
  lines: PayoutLine[]; // 산정 명세(세션별)
  rejectedReason?: string;
  paidAt?: string;
  confirmedAt?: string;
  // [B9 E5 2026-07-16] 지급 회수(reversal) 시각 — 계약 PayoutStatus에 'reversed'를 추가할 수 없어
  //  (owner npm 재발행 불가) 상태는 rejected를 재사용하고, 회수 여부는 이 필드로 판별한다.
  //  회수 = paid → rejected + 보상 원장 거래(in/payout_reversal) + 세션 연결 해제(한 tx).
  reversedAt?: string;
} & BaseRow;

// 통합 원장 행 — transactions 모듈이 단일 소스(계약 v0.1.10에 payoutId 역참조 포함).
export type { Transaction as TransactionRow } from '../transactions/transaction.entity';
