import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { COUNSEL_STATUSES } from '../counsel.entity'; // [P2 M5]
import type { CounselFormSnapshot } from '@kms545487/contracts';
import { COUNSEL_TEXT } from './create-counsel.dto';
import { CounselInstantField } from '../counsel-instant';

const STATUS = COUNSEL_STATUSES; // [P2 M5]
type CounselFormInputSnapshot = Pick<
  CounselFormSnapshot,
  'studentId' | 'status' | 'referenceNotes' | 'nextContactAt'
>;

/** 차수 페이지에서 편집 가능한 필드. 서버가 현재 폼의 내부 메타데이터와 병합한다. */
export class CounselFormSnapshotDto implements CounselFormInputSnapshot {
  @IsInt() studentId!: number;
  @IsIn(STATUS as unknown as string[]) status!: CounselFormInputSnapshot['status'];
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string | null;
  @IsOptional() @CounselInstantField({ nullable: true })
  nextContactAt?: string | null;
}
