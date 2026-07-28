import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import type { CreateCounselInput } from '@kms545487/contracts';
import { CounselInstantField } from '../counsel-instant';

// [참조/처리] POST /counsel — 상담 접수 생성. 관심 코스/과목·담당자 FK는 서비스가 검증.
export const SOURCES = ['internal_form', 'naver_form', 'google_form', 'manual', 'etc'] as const;
export const SUBMITTERS = ['parent', 'student', 'staff', 'unknown'] as const;
// [보안 2026-07-07] 자유 텍스트 상한 — 스케줄 DTO와 통일(무제한 문자열 = 저장 남용/페이로드 비대 방지).
export const COUNSEL_TEXT = { referenceNotes: 2000 } as const;

export class CreateCounselDto implements CreateCounselInput {
  @IsInt() studentId!: number;
  @IsIn(SOURCES as unknown as string[]) source!: CreateCounselInput['source'];
  @IsOptional() @IsIn(SUBMITTERS as unknown as string[]) submitterType?: CreateCounselInput['submitterType'];
  @IsOptional() @IsInt() assignedStaffId?: number;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string;
  @IsOptional() @CounselInstantField() nextContactAt?: string;
}
