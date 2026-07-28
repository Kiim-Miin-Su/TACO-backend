import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { COUNSEL_STATUSES } from '../counsel.entity'; // [P2 M5]
import type { CounselFormSnapshot } from '@kms545487/contracts';
import {
  COUNSEL_TEXT,
  SOURCES,
  SUBMITTERS,
} from './create-counsel.dto';
import { CounselInstantField } from '../counsel-instant';

const STATUS = COUNSEL_STATUSES; // [P2 M5]

/** 차수 페이지에 저장되는 전체 상담 폼 스냅샷. DTO whitelist가 JSON 내부 키도 제한한다. */
export class CounselFormSnapshotDto implements CounselFormSnapshot {
  @IsInt() studentId!: number;
  @IsOptional() @IsInt() assignedStaffId?: number | null;
  @IsIn(STATUS as unknown as string[]) status!: CounselFormSnapshot['status'];
  @IsIn(SOURCES as unknown as string[]) source!: CounselFormSnapshot['source'];
  @IsIn(SUBMITTERS as unknown as string[]) submitterType!: CounselFormSnapshot['submitterType'];
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string | null;
  @IsOptional() @CounselInstantField({ nullable: true })
  nextContactAt?: string | null;
}
