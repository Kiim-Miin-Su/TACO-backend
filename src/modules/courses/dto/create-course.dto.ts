import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { CreateCourseInput } from '@kms545487/contracts';

export class CreateCourseDto implements CreateCourseInput {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional() @IsString() @MaxLength(20)
  color?: string; // 캘린더 색상 라벨(개설 시 선택)

  @IsInt()
  subjectId!: number;

  @IsInt()
  instructorId!: number;

  @IsInt()
  @Min(0)
  price!: number;

  @IsInt()
  @Min(0)
  hourlyRate!: number;
}
