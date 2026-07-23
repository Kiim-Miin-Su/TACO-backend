// [TBO-47 2026-07-23] 로드맵 DTO — CreateRoadmapInput 계약 소비 + 운영 필드(durationWeeks/isActive).
import { ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { CreateRoadmapInput } from '@kms545487/contracts';

export class CreateRoadmapDto implements CreateRoadmapInput {
  @IsString() @MinLength(1) @MaxLength(100) title!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(13) targetGrade?: number; // Kinder(0)~G13 — 학생 학년 정책과 동일 범위
  @IsOptional() @IsInt() @Min(1) @Max(104) durationWeeks?: number;
  @IsOptional() @IsArray() @IsInt({ each: true }) courseIds?: number[]; // 생성과 동시에 순서대로 연결(한 tx)
}

export class UpdateRoadmapDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) title?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsInt() @Min(0) @Max(13) targetGrade?: number;
  @IsOptional() @IsInt() @Min(1) @Max(104) durationWeeks?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class AddRoadmapCourseDto {
  @IsInt() @Min(1) courseId!: number;
}

export class ReorderRoadmapCoursesDto {
  /** 로드맵의 전체 courseId를 원하는 순서로 — 부분 목록은 400(조용한 누락 금지). */
  @IsArray() @ArrayNotEmpty() @IsInt({ each: true }) courseIds!: number[];
}
