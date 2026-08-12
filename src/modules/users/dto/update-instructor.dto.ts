import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { normalizeStaffEnglishName, STAFF_ENGLISH_NAME_MAX_LENGTH, STAFF_ENGLISH_NAME_MESSAGE, STAFF_ENGLISH_NAME_PATTERN, type UpdateInstructorInput } from '@kms545487/contracts';
import { MAX_AMOUNT } from '../../../common/validation-limits';

export class UpdateInstructorDto implements UpdateInstructorInput {
  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional() @IsString() @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ maxLength: STAFF_ENGLISH_NAME_MAX_LENGTH, example: 'Jiwon Kim', pattern: STAFF_ENGLISH_NAME_PATTERN.source })
  @Transform(({ value }) => typeof value === 'string' ? normalizeStaffEnglishName(value) : value)
  @IsOptional() @IsString() @MaxLength(STAFF_ENGLISH_NAME_MAX_LENGTH)
  @Matches(STAFF_ENGLISH_NAME_PATTERN, { message: STAFF_ENGLISH_NAME_MESSAGE })
  englishName?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional() @IsString() @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional() @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 100 })
  @IsOptional() @IsString() @MaxLength(100)
  university?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 100 })
  @IsOptional() @IsString() @MaxLength(100)
  major?: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1940, maximum: 2020 })
  @IsOptional() @IsInt() @Min(1940) @Max(2020)
  birthYear?: number | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 8 })
  @IsOptional() @IsString() @MaxLength(8)
  countryCode?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 64 })
  @IsOptional() @IsString() @MaxLength(64)
  timeZone?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_AMOUNT })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT)
  defaultHourlyRate?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  canTeachKinder?: boolean;
}
