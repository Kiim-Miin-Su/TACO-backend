import { IsInt, IsOptional, IsString, Min, Max, MaxLength } from 'class-validator';
import type { CreateEnrollmentInput } from '@kms545487/contracts';
import { TEXT, MAX_COUNT } from '../../../common/validation-limits'; // [보안] 상한 단일 소스

export class CreateEnrollmentDto implements CreateEnrollmentInput {
  @IsInt()
  studentId!: number;

  @IsInt()
  courseId!: number;

  @IsOptional()
  @IsInt()
  roadmapId?: number;

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
