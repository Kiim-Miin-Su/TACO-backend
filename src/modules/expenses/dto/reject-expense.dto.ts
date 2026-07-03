import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RejectExpenseDto {
  @IsOptional() @IsString() @MaxLength(200)
  reason?: string; // 반려 사유 — Expense.rejectedReason에 저장(자산화, v0.1.12)
}
