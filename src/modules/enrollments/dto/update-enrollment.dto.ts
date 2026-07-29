import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { EnrollmentStatus, UpdateEnrollmentInput } from '@kms545487/contracts';
import { ENROLLMENT_STATUSES } from '../enrollment.entity';
import { MAX_COUNT, TEXT } from '../../../common/validation-limits';

export class UpdateEnrollmentDto implements UpdateEnrollmentInput {
  @IsOptional()
  @IsIn(ENROLLMENT_STATUSES)
  status?: EnrollmentStatus;

  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  startDate?: string | null;

  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  endDate?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COUNT)
  totalSessions?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string | null;

  @IsString()
  @MaxLength(TEXT.memo)
  reason!: string;
}
