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
export type { PayoutStatus } from '@kms545487/contracts'; // [P2 3-A] 로컬 재정의 제거 — 계약 단일 진실원
import type {
  InstructorPayout,
  PayoutLine as ContractPayoutLine,
} from '@kms545487/contracts';

export type PayoutLine = ContractPayoutLine;
export type InstructorPayoutRow = InstructorPayout & BaseRow;

// 통합 원장 행 — transactions 모듈이 단일 소스(계약 v0.1.10에 payoutId 역참조 포함).
export type { Transaction as TransactionRow } from '../transactions/transaction.entity';
