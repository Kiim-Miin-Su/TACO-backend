import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { CreateEnrollmentInput } from '@kms545487/contracts';

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
  totalSessions?: number;

  @IsOptional()
  @IsString()
  memo?: string;
}
