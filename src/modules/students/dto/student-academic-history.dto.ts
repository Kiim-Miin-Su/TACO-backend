import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { CreateStudentAcademicHistoryInput, UpdateStudentAcademicHistoryInput } from '@kms545487/contracts';

export class CreateStudentAcademicHistoryDto implements Omit<CreateStudentAcademicHistoryInput, 'studentId'> {
  @IsInt() @Min(0) @Max(13) grade!: number;
  @IsString() @MaxLength(100) schoolName!: string;
  @IsDateString({ strict: true }) startedOn!: string;
  @IsOptional() @IsDateString({ strict: true }) endedOn?: string | null;
}

export class UpdateStudentAcademicHistoryDto implements UpdateStudentAcademicHistoryInput {
  @IsOptional() @IsInt() @Min(0) @Max(13) grade?: number;
  @IsOptional() @IsString() @MaxLength(100) schoolName?: string;
  @IsOptional() @IsDateString({ strict: true }) startedOn?: string;
  @IsOptional() @IsDateString({ strict: true }) endedOn?: string | null;
}
