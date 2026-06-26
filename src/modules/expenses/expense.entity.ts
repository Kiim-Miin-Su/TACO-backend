import type { Expense as ExpenseContract } from '@taco/contracts';
import type { BaseRow } from '../../common/types/base';

export type { ExpenseCategory, ApprovalStatus } from '@taco/contracts';
export type Expense = ExpenseContract & BaseRow;
export const EXPENSES = 'expenses';
