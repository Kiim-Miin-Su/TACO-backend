import type { Transaction as TransactionContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// 통합 원장(입·출금). payouts 모듈의 pay()가 같은 컬렉션('transactions')에 출금 1줄을 기록하며,
// 여기서 데모 재무 활동을 시드한다. 계약 형상(direction·category·label·method·occurredAt) 사용.
// 원장 역참조(어느 문서에서 발생한 입·출금인지) — 백엔드 로컬 확장.
//  payouts.pay(payoutId)와 동일 패턴으로 수납(paymentId)·지출 승인(expenseId)을 추적한다.
//  TODO: contracts Transaction으로 승격(다음 contracts 버전).
export type Transaction = TransactionContract & BaseRow & { payoutId?: number; paymentId?: number; expenseId?: number };
export const TRANSACTIONS = 'transactions';
