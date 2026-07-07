import { IsBoolean, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';
import type { CreateParentInput } from '@kms545487/contracts';
import { TEXT } from '../../../common/validation-limits'; // [보안] 자유 텍스트 상한 단일 소스

// [참조/처리] POST /parents — 신규 보호자 + 학생 연결. studentId FK는 서비스가 검증.
export class CreateParentDto implements CreateParentInput {
  @IsString()
  @MaxLength(TEXT.name)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.short)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.webId)
  webId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.short)
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
