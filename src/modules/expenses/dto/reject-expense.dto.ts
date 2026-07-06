import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// [Q2 결정 2026-07-06] 반려 사유 **필수** — schedule_requests와 반려류 패턴 통일(TBO-16).
// [A1 2026-07-06] 반려 액션 전용(reason 1필드) — contracts 미승격(A1 제외).
export class RejectExpenseDto {
  @ApiProperty({ example: '증빙 누락 — 영수증 첨부 후 재신청', description: '반려 사유(필수)' })
  @IsString() @IsNotEmpty({ message: '반려 사유는 필수입니다' }) @MaxLength(200)
  reason!: string; // Expense.rejectedReason에 저장(자산화, v0.1.12)
}
