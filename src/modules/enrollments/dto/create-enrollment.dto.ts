import { IsDateString, IsInt, IsOptional, IsString, Min, Max, MaxLength } from 'class-validator';
import type { CreateEnrollmentInput } from '@kms545487/contracts';
import { TEXT, MAX_COUNT } from '../../../common/validation-limits'; // [보안] 상한 단일 소스

export class CreateEnrollmentDto implements CreateEnrollmentInput {
  @IsInt()
  @Min(1)
  studentId!: number;

  @IsInt()
  @Min(1)
  courseId!: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  counselCardId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  roadmapId?: number;

  @IsOptional()
  @IsDateString({ strict: true }, { message: 'startDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  startDate?: string;

  @IsOptional()
  @IsDateString({ strict: true }, { message: 'endDate는 유효한 YYYY-MM-DD 날짜여야 합니다.' })
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COUNT)
  totalSessions?: number;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string;
}
