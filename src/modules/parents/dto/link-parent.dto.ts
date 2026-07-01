import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';

// [참조/처리] POST /parents/link — 기존 보호자를 학생에 연결(형제=한 보호자 여러 자녀).
export class LinkParentDto {
  @IsInt()
  @Min(1)
  parentId!: number;

  @IsInt()
  @Min(1)
  studentId!: number;

  @IsOptional()
  @IsString()
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
  relation?: string;

  @IsOptional()
  @IsBoolean()
  isPayer?: boolean;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
