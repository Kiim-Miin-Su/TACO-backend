import { IsOptional, IsString, MaxLength } from 'class-validator';

// [A1 2026-07-06] CreateReportTemplateInput 승격은 실익 낮음 판정(2026-07-03 통신 감사 백로그, A1 제외).
export class CreateReportTemplateDto {
  @IsString() @MaxLength(40)
  name!: string;

  @IsString() @MaxLength(2000)
  content!: string;

  @IsOptional() @IsString() @MaxLength(1000)
  homework?: string;
}
