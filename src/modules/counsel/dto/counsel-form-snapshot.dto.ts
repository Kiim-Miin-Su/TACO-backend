import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { CounselFormSnapshot } from '@kms545487/contracts';
import {
  COUNSEL_DATE,
  COUNSEL_TEXT,
  SOURCES,
  SUBMITTERS,
} from './create-counsel.dto';

const STATUS = ['requested', 'pending', 'registered', 'dropped'] as const;

/** 차수 페이지에 저장되는 전체 상담 폼 스냅샷. DTO whitelist가 JSON 내부 키도 제한한다. */
export class CounselFormSnapshotDto implements CounselFormSnapshot {
  @IsInt() studentId!: number;
  @IsOptional() @IsInt() assignedStaffId?: number | null;
  @IsIn(STATUS as unknown as string[]) status!: CounselFormSnapshot['status'];
  @IsIn(SOURCES as unknown as string[]) source!: CounselFormSnapshot['source'];
  @IsIn(SUBMITTERS as unknown as string[]) submitterType!: CounselFormSnapshot['submitterType'];
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string | null;
  @IsOptional() @Matches(COUNSEL_DATE, { message: 'formSnapshot.nextContactAt must be YYYY-MM-DD' })
  nextContactAt?: string | null;
}
