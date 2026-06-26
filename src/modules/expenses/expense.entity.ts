import type { Expense as ExpenseContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type { ExpenseCategory, ApprovalStatus } from '@kms545487/contracts';
export type Expense = ExpenseContract & BaseRow;
export const EXPENSES = 'expenses';
