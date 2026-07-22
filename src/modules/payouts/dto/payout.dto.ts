import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, Min, MinLength, Max, MaxLength } from 'class-validator';
import { TEXT, MAX_AMOUNT } from '../../../common/validation-limits'; // [보안] 상한 단일 소스

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// POST /payouts/generate — 기간 내 적격 세션을 묶어 정산서 생성
// [A1 2026-07-06] 정산 생성은 CreatePayoutInput과 필드 상이(기간 자동 산정) + adjust/reject는 액션 전용 — 정산 API 재설계(TBO-15 self-service) 때 통합 검토(A1 제외).
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

// [TBO-32 C1 2026-07-20] POST /payouts/generate-bulk — 기간 내 전(또는 지정) 강사 일괄 산정.
//  강사별 독립 tx — 부분 실패 요약 응답(generated/skipped/failed). 대상 미지정 = 활성 강사 전원.
export class GenerateBulkPayoutDto {
  @ApiProperty({ example: '2026-06-01', description: '정산 기간 시작(YYYY-MM-DD)' })
  @Matches(DATE, { message: 'periodStart must be YYYY-MM-DD' })
  periodStart!: string;

  @ApiProperty({ example: '2026-06-30', description: '정산 기간 종료(YYYY-MM-DD)' })
  @Matches(DATE, { message: 'periodEnd must be YYYY-MM-DD' })
  periodEnd!: string;

  @ApiPropertyOptional({ type: [Number], description: '대상 강사 id 목록(미지정 = 활성 강사 전원)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  instructorIds?: number[];
}

// POST /payouts/:id/adjust — 대표 급여 수정(실효 지급액 덮어쓰기)
export class AdjustPayoutDto {
  @ApiProperty({ example: 150000, description: '실효 지급액(원). 자동 산정액은 보존됨' })
  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT)
  amount!: number;

  @ApiPropertyOptional({ example: '교통비 차감', description: '수정 사유' })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  reason?: string;
}

// POST /payouts/:id/reject — 대표 반려(+연결 세션 회수)
// [B9 E5] 지급 회수 — 금전 보상 command라 사유 필수(반려와 달리 선택 아님).
export class ReversePayoutDto {
  @ApiProperty({ example: '보고서 반려로 시수 재산정 필요', description: '회수 사유(감사 이력·강사 표시)' })
  @IsString()
  @MinLength(5)
  @MaxLength(TEXT.memo)
  reason!: string;
}

// [TBO-32 C2 2026-07-22] POST /payouts/:id/unconfirm — 확정 취소(사유 필수·감사 이력).
export class UnconfirmPayoutDto {
  @ApiProperty({ example: '기간 오설정 — 재산정 후 재확정 예정', description: '확정 취소 사유(감사 이력)' })
  @IsString()
  @MinLength(5)
  @MaxLength(TEXT.memo)
  reason!: string;
}

export class RejectPayoutDto {
  @ApiPropertyOptional({ example: '근태 확인 필요', description: '반려 사유(강사에게 표시)' })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  reason?: string;
}
