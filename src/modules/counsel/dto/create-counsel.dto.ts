import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import type { CreateCounselInput } from '@kms545487/contracts';

// [참조/처리] POST /counsel — 상담 접수 생성. 관심 코스/과목·담당자 FK는 서비스가 검증.
const SOURCES = ['internal_form', 'naver_form', 'google_form', 'manual', 'etc'] as const;
const START = ['immediately', 'within_1_month', 'within_2_3_months', 'undecided'] as const;
const ATMOS = ['self_directed', 'normal', 'needs_management'] as const;
const INTENT = ['student_wants', 'parent_only', 'unknown'] as const;

export class CreateCounselDto implements CreateCounselInput {
  @IsString() applicantName!: string;
  @IsOptional() @IsString() applicantPhone?: string;
  @IsIn(SOURCES as unknown as string[]) source!: CreateCounselInput['source'];
  @IsOptional() @IsInt() assignedStaffId?: number;
  @IsOptional() @IsInt() interestSubjectId?: number;
  @IsOptional() @IsInt() interestCourseId?: number;
  @IsOptional() @IsString() academyExpectation?: string;
  @IsOptional() @IsIn(START as unknown as string[]) desiredStartTime?: CreateCounselInput['desiredStartTime'];
  @IsOptional() @IsIn(ATMOS as unknown as string[]) learningAtmosphere?: CreateCounselInput['learningAtmosphere'];
  @IsOptional() @IsIn(INTENT as unknown as string[]) studentIntention?: CreateCounselInput['studentIntention'];
  @IsOptional() @IsString() weakness?: string;
}
