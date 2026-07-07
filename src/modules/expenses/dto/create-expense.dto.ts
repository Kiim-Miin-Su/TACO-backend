import { IsIn, IsInt, IsOptional, IsString, Min, Max, MaxLength } from 'class-validator';
import type { CreateExpenseInput } from '@kms545487/contracts';
import { ExpenseCategory } from '../expense.entity';
import { TEXT } from '../../../common/validation-limits'; // [보안] 자유 텍스트 상한 단일 소스

const CATEGORIES: ExpenseCategory[] = [
  'supplies', 'equipment', 'books', 'rent', 'utility', 'marketing', 'meal', 'etc',
];

export class CreateExpenseDto implements CreateExpenseInput {
  @IsIn(CATEGORIES)
  category!: ExpenseCategory;

  @IsString()
  @MaxLength(TEXT.name)
  title!: string;

  @IsInt()
  @Min(0)
  @Max(100_000_000) // [감사 H5] 상한 1억 — 오입력·오버플로우 방지
  amount!: number;

  @IsString()
  @MaxLength(TEXT.short)
  spentAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.name)
  vendor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.url)
  receiptUrl?: string;
}
