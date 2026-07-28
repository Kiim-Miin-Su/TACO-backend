import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { COUNSEL_STATUSES } from '../counsel.entity'; // [P2 M5]
import type { UpdateCounselInput } from '@kms545487/contracts';
import { COUNSEL_TEXT, SOURCES, SUBMITTERS } from './create-counsel.dto'; // [보안] 자유 텍스트 상한 단일 소스
import { CounselInstantField } from '../counsel-instant';

// [참조/처리] PATCH /counsel/:id — 상태 전환·담당자·관심사 수정. status는 계약 유니온 검사.
const STATUS = COUNSEL_STATUSES; // [P2 M5] 진실원(counsel.entity)
export class UpdateCounselDto implements UpdateCounselInput {
  @IsOptional() @IsIn(STATUS as unknown as string[]) status?: UpdateCounselInput['status'];
  @IsOptional() @IsIn(SOURCES as unknown as string[]) source?: UpdateCounselInput['source'];
  @IsOptional() @IsIn(SUBMITTERS as unknown as string[]) submitterType?: UpdateCounselInput['submitterType'];
  @IsOptional() @IsInt() studentId?: number;
  @IsOptional() @IsInt() assignedStaffId?: number | null;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string | null;
  @IsOptional() @CounselInstantField({ nullable: true }) nextContactAt?: string | null;
}
