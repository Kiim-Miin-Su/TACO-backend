import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { CounselFormSnapshot } from '@kms545487/contracts';
import {
  ATMOS,
  COUNSEL_DATE,
  COUNSEL_TEXT,
  INTENT,
  SOURCES,
  START,
  SUBMITTERS,
} from './create-counsel.dto';

const STATUS = ['requested', 'pending', 'registered', 'dropped'] as const;

/** 차수 페이지에 저장되는 전체 상담 폼 스냅샷. DTO whitelist가 JSON 내부 키도 제한한다. */
export class CounselFormSnapshotDto implements CounselFormSnapshot {
  @IsString() @MaxLength(COUNSEL_TEXT.name) applicantName!: string;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.phone) applicantPhone?: string | null;
  @IsOptional() @IsInt() parentId?: number | null;
  @IsOptional() @IsInt() studentId?: number | null;
  @IsOptional() @IsInt() assignedStaffId?: number | null;
  @IsIn(STATUS as unknown as string[]) status!: CounselFormSnapshot['status'];
  @IsIn(SOURCES as unknown as string[]) source!: CounselFormSnapshot['source'];
  @IsIn(SUBMITTERS as unknown as string[]) submitterType!: CounselFormSnapshot['submitterType'];
  @IsOptional() @IsInt() interestSubjectId?: number | null;
  @IsOptional() @IsInt() interestCourseId?: number | null;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.expectation) academyExpectation?: string | null;
  @IsOptional() @IsIn(START as unknown as string[]) desiredStartTime?: CounselFormSnapshot['desiredStartTime'];
  @IsOptional() @IsIn(ATMOS as unknown as string[]) learningAtmosphere?: CounselFormSnapshot['learningAtmosphere'];
  @IsOptional() @IsIn(INTENT as unknown as string[]) studentIntention?: CounselFormSnapshot['studentIntention'];
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.weakness) weakness?: string | null;
  @IsOptional() @Matches(COUNSEL_DATE, { message: 'formSnapshot.nextContactAt must be YYYY-MM-DD' })
  nextContactAt?: string | null;
}
