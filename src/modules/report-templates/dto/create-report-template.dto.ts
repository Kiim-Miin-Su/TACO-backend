import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { CreateReportTemplateInput } from '@kms545487/contracts';

export class CreateReportTemplateDto implements CreateReportTemplateInput {
  @IsString() @MaxLength(40)
  name!: string;

  @IsString() @MaxLength(2000)
  content!: string;

  @IsOptional() @IsString() @MaxLength(1000)
  progressPage?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  homework?: string;

  @IsOptional() @IsInt() @Min(1)
  ownerUserId?: number | null;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;

  @IsOptional() @IsBoolean()
  isEnforced?: boolean;
}
