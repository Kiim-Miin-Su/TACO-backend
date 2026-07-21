import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { UpdateCounselInput } from '@kms545487/contracts';
import { COUNSEL_DATE, COUNSEL_TEXT, SOURCES, SUBMITTERS } from './create-counsel.dto'; // [보안] 자유 텍스트 상한 단일 소스

// [참조/처리] PATCH /counsel/:id — 상태 전환·담당자·관심사 수정. status는 계약 유니온 검사.
const STATUS = ['requested', 'pending', 'registered', 'dropped'] as const;
const START = ['immediately', 'within_1_month', 'within_2_3_months', 'undecided'] as const;
const ATMOS = ['self_directed', 'normal', 'needs_management'] as const;
const INTENT = ['student_wants', 'parent_only', 'unknown'] as const;

export class UpdateCounselDto implements UpdateCounselInput {
  @IsOptional() @IsIn(STATUS as unknown as string[]) status?: UpdateCounselInput['status'];
  @IsOptional() @IsIn(SOURCES as unknown as string[]) source?: UpdateCounselInput['source'];
  @IsOptional() @IsIn(SUBMITTERS as unknown as string[]) submitterType?: UpdateCounselInput['submitterType'];
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.name) applicantName?: string;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.phone) applicantPhone?: string | null;
  @IsOptional() @IsInt() assignedStaffId?: number | null;
  @IsOptional() @IsInt() interestSubjectId?: number | null;
  @IsOptional() @IsInt() interestCourseId?: number | null;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.expectation) academyExpectation?: string | null;
  @IsOptional() @IsIn(START as unknown as string[]) desiredStartTime?: UpdateCounselInput['desiredStartTime'];
  @IsOptional() @IsIn(ATMOS as unknown as string[]) learningAtmosphere?: UpdateCounselInput['learningAtmosphere'];
  @IsOptional() @IsIn(INTENT as unknown as string[]) studentIntention?: UpdateCounselInput['studentIntention'];
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.weakness) weakness?: string | null;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string | null;
  @IsOptional() @Matches(COUNSEL_DATE, { message: 'nextContactAt must be YYYY-MM-DD' }) nextContactAt?: string | null;
}
