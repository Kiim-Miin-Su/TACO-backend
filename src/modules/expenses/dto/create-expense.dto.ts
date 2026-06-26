import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { CreateExpenseInput } from '@taco/contracts';
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
