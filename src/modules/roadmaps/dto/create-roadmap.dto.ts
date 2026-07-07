import { ArrayUnique, IsArray, IsInt, IsOptional, IsString, Min, MaxLength } from 'class-validator';
import type { CreateRoadmapInput } from '@kms545487/contracts';
import { TEXT } from '../../../common/validation-limits'; // [보안] 자유 텍스트 상한 단일 소스

// [참조/처리] POST /roadmaps 바디. courseIds는 연결할 코스(순서대로) — 서비스가 코스 FK 존재를 검증.
export class CreateRoadmapDto implements CreateRoadmapInput {
  @IsString()
  @MaxLength(TEXT.name)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.long)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  targetGrade?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique() // 같은 코스 중복 링크 방지(입력 단계)
  @IsInt({ each: true })
  courseIds?: number[];
}
