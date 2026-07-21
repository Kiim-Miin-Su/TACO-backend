import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { CreateCounselInput } from '@kms545487/contracts';

// [참조/처리] POST /counsel — 상담 접수 생성. 관심 코스/과목·담당자 FK는 서비스가 검증.
const SOURCES = ['internal_form', 'naver_form', 'google_form', 'manual', 'etc'] as const;
export const SUBMITTERS = ['parent', 'student', 'staff', 'unknown'] as const;
const START = ['immediately', 'within_1_month', 'within_2_3_months', 'undecided'] as const;
const ATMOS = ['self_directed', 'normal', 'needs_management'] as const;
const INTENT = ['student_wants', 'parent_only', 'unknown'] as const;
export const COUNSEL_DATE = /^\d{4}-\d{2}-\d{2}$/;

// [보안 2026-07-07] 자유 텍스트 상한 — 스케줄 DTO와 통일(무제한 문자열 = 저장 남용/페이로드 비대 방지).
export const COUNSEL_TEXT = { name: 60, phone: 30, weakness: 500, expectation: 1000 } as const;

export class CreateCounselDto implements CreateCounselInput {
  @IsString() @MaxLength(COUNSEL_TEXT.name) applicantName!: string;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.phone) applicantPhone?: string;
  @IsIn(SOURCES as unknown as string[]) source!: CreateCounselInput['source'];
  @IsOptional() @IsIn(SUBMITTERS as unknown as string[]) submitterType?: CreateCounselInput['submitterType'];
  @IsOptional() @IsInt() assignedStaffId?: number;
  @IsOptional() @IsInt() interestSubjectId?: number;
  @IsOptional() @IsInt() interestCourseId?: number;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.expectation) academyExpectation?: string;
  @IsOptional() @IsIn(START as unknown as string[]) desiredStartTime?: CreateCounselInput['desiredStartTime'];
  @IsOptional() @IsIn(ATMOS as unknown as string[]) learningAtmosphere?: CreateCounselInput['learningAtmosphere'];
  @IsOptional() @IsIn(INTENT as unknown as string[]) studentIntention?: CreateCounselInput['studentIntention'];
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.weakness) weakness?: string;
  @IsOptional() @Matches(COUNSEL_DATE, { message: 'nextContactAt must be YYYY-MM-DD' }) nextContactAt?: string;
}
