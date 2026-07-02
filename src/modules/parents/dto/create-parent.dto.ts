import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import type { CreateParentInput } from '@kms545487/contracts';

// [참조/처리] POST /parents — 신규 보호자 + 학생 연결. studentId FK는 서비스가 검증.
export class CreateParentDto implements CreateParentInput {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  webId?: string;

  @IsOptional()
  @IsString()
  relation?: string;

  @IsOptional()
  @IsBoolean()
  isPayer?: boolean;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsInt()
  @Min(1)
  studentId!: number;
}
