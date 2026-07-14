import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

// [TBO-28B] 가입 반려 — 사유 필수(expenses/schedule-requests 반려 규약과 통일). audit_log에 남는다.
export class RejectDto {
  @ApiProperty({ description: '반려 사유(필수) — audit_log에 기록', minLength: 2, maxLength: 500 })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;
}
