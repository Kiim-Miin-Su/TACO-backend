import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import type {
  CreateInstructorContractInput,
  UpdateInstructorContractInput,
} from '@kms545487/contracts';
import { MAX_AMOUNT, MAX_COUNT, TEXT } from '../../../common/validation-limits';

export class CreateInstructorContractDto implements CreateInstructorContractInput {
  @IsInt()
  instructorId!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_COUNT)
  monthlyHours!: number;

  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT)
  hourlyRate!: number;

  @IsDateString({ strict: true })
  periodStart!: string;

  @IsOptional()
  @IsDateString({ strict: true })
  periodEnd?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string | null;
}

export class UpdateInstructorContractDto implements UpdateInstructorContractInput {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_COUNT)
  monthlyHours?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT)
  hourlyRate?: number;

  @IsOptional()
  @IsDateString({ strict: true })
  periodStart?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  periodEnd?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string | null;

  @IsString()
  @MinLength(2)
  @MaxLength(TEXT.memo)
  reason!: string;
}
