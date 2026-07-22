import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import type { OpenClassInput, OpenClassSeriesInput } from '@kms545487/contracts';
import { MAX_AMOUNT } from '../../../common/validation-limits';
import { CreateScheduleDto } from './create-schedule.dto';
import { CreateScheduleSeriesDto } from './create-schedule-series.dto';

export class OpenClassDto extends OmitType(CreateScheduleDto, [
  'courseId',
  'instructorId',
  'studentIds',
  'seriesId',
  'makeupForSessionId',
] as const) implements OpenClassInput {
  @ApiProperty({ example: 'Writing' })
  @IsString() @Matches(/\S/) @MaxLength(50)
  subjectName!: string;

  @ApiProperty({ example: 7 })
  @IsInt() @Min(1)
  instructorId!: number;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsInt({ each: true }) @Min(1, { each: true })
  studentIds?: number[];

  @ApiPropertyOptional({ nullable: true, example: 45000 })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT)
  hourlyRateOverride?: number | null;

  @ApiPropertyOptional({ example: 320000 })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT)
  coursePrice?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional() @IsBoolean()
  isKinder?: boolean;
}

export class OpenClassSeriesDto extends OmitType(CreateScheduleSeriesDto, [
  'courseId',
  'instructorId',
  'studentIds',
] as const) implements OpenClassSeriesInput {
  @ApiProperty({ example: 'Writing' })
  @IsString() @Matches(/\S/) @MaxLength(50)
  subjectName!: string;

  @ApiProperty({ example: 7 })
  @IsInt() @Min(1)
  instructorId!: number;

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(20) @IsInt({ each: true }) @Min(1, { each: true })
  studentIds?: number[];

  @ApiPropertyOptional({ nullable: true, example: 45000 })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT)
  hourlyRateOverride?: number | null;

  @ApiPropertyOptional({ example: 320000 })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT)
  coursePrice?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional() @IsBoolean()
  isKinder?: boolean;
}
