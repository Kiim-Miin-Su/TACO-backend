import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// 반려 — 사유 **필수**(Q2 결정 2026-07-06, expenses.reject도 필수로 통일).
export class RejectScheduleRequestDto {
  @ApiProperty({ example: '해당 시간 강의실 예약 불가 — 다른 시간 제안 바랍니다', description: '반려 사유(필수)' })
  @IsString() @IsNotEmpty({ message: '반려 사유는 필수입니다' }) @MaxLength(200)
  reason!: string;
}
