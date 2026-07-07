import { IsInt, IsOptional, IsString, MaxLength, Min, Max } from 'class-validator';
import type { CreateCourseInput } from '@kms545487/contracts';
import { MAX_AMOUNT } from '../../../common/validation-limits'; // [보안] 금액 상한 단일 소스

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
  @Max(MAX_AMOUNT)
  price!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT)
  hourlyRate!: number;
}
