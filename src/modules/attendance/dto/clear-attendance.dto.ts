import type { ClearAttendanceInput } from '@kms545487/contracts';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { TEXT } from '../../../common/validation-limits';

export class ClearAttendanceDto implements ClearAttendanceInput {
  @IsString()
  @MinLength(2)
  @MaxLength(TEXT.memo)
  reason!: string;

  // [TBO-79 B4] held → scheduled 역전이가 정산 예상액을 바꿀 때의 명시 확인 — schedule과 동일 규약.
  @ApiPropertyOptional({ description: '회계 영향 확인 여부(409 미리보기를 본 뒤 true)' })
  @IsOptional()
  @IsBoolean()
  acknowledgeAccountingImpact?: boolean;

  @ApiPropertyOptional({ description: '확인한 영향의 지문 — 서버 재계산 값과 다르면 새 409' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedAccountingImpactHash?: string;
}
