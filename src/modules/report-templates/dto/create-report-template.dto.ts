import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { CreateReportTemplateInput } from '@kms545487/contracts';

export class CreateReportTemplateDto implements CreateReportTemplateInput {
  @IsString() @MaxLength(40)
  name!: string;

  @IsString() @MaxLength(2000)
  content!: string;

  @IsOptional() @IsString() @MaxLength(1000)
  homework?: string;
}
