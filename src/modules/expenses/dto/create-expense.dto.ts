import { IsIn, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import type { CreateExpenseInput } from '@kms545487/contracts';
import { ExpenseCategory } from '../expense.entity';

const CATEGORIES: ExpenseCategory[] = [
  'supplies', 'equipment', 'books', 'rent', 'utility', 'marketing', 'meal', 'etc',
];

export class CreateExpenseDto implements CreateExpenseInput {
  @IsIn(CATEGORIES)
  category!: ExpenseCategory;

  @IsString()
  title!: string;

  @IsInt()
  @Min(0)
  @Max(100_000_000) // [감사 H5] 상한 1억 — 오입력·오버플로우 방지
  amount!: number;

  @IsString()
  spentAt!: string;

  @IsOptional()
  @IsString()
  vendor?: string;

  @IsOptional()
  @IsString()
  memo?: string;

  @IsOptional()
  @IsString()
  receiptUrl?: string;
}
