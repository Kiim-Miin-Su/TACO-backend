import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import type { CreateCourseInput } from '@kms545487/contracts';

export class CreateCourseDto implements CreateCourseInput {
  @IsString()
  @MaxLength(100)
  name!: string;

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
