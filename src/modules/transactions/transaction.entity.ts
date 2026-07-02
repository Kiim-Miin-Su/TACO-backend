import type { Transaction as TransactionContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// 통합 원장(입·출금). payouts 모듈의 pay()가 같은 컬렉션('transactions')에 출금 1줄을 기록하며,
// 여기서 데모 재무 활동을 시드한다. 계약 형상(direction·category·label·method·occurredAt) 사용.
export type Transaction = TransactionContract & BaseRow;
export const TRANSACTIONS = 'transactions';
