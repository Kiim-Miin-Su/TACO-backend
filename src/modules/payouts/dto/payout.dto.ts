import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// POST /payouts/generate — 기간 내 적격 세션을 묶어 정산서 생성
export class GeneratePayoutDto {
  @ApiProperty({ example: 1, description: '강사(users.id)' })
  @IsInt()
  instructorId!: number;

  @ApiProperty({ example: '2026-06-01', description: '정산 기간 시작(YYYY-MM-DD)' })
  @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({ example: '2026-06-30', description: '정산 기간 종료(YYYY-MM-DD)' })
  @Matches(DATE, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}

// POST /payouts/:id/adjust — 관리자 급여 수정(실효 지급액 덮어쓰기)
export class AdjustPayoutDto {
  @ApiProperty({ example: 150000, description: '실효 지급액(원). 자동 산정액은 보존됨' })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ example: '교통비 차감', description: '수정 사유' })
  @IsOptional()
  @IsString()
  reason?: string;
}

// POST /payouts/:id/reject — 관리자 반려(+연결 세션 회수)
export class RejectPayoutDto {
  @ApiPropertyOptional({ example: '근태 확인 필요', description: '반려 사유(강사에게 표시)' })
  @IsOptional()
  @IsString()
  reason?: string;
}
