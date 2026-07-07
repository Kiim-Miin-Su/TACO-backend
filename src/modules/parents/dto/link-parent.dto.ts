import { IsBoolean, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';
import type { LinkParentInput } from '@kms545487/contracts';
import { TEXT } from '../../../common/validation-limits'; // [보안] 자유 텍스트 상한 단일 소스

// [참조/처리] POST /parents/link — 기존 보호자를 학생에 연결(형제=한 보호자 여러 자녀).
// [v0.1.14 A1] implements LinkParentInput(신설) — ParentLinkInput(임베드용)과 다른 계약이라 별도 명문화.
export class LinkParentDto implements LinkParentInput {
  @IsInt()
  @Min(1)
  parentId!: number;

  @IsInt()
  @Min(1)
  studentId!: number;

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
}

// [참조/처리] PATCH /parents/relations/:id — 관계 수정(대표 이전·납부자 변경).
export class UpdateRelationDto {
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
}
