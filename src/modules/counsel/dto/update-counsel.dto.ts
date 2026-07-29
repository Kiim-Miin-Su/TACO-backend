import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { COUNSEL_STATUSES } from '../counsel.entity'; // [P2 M5]
import type { UpdateCounselInput } from '@kms545487/contracts';
import { COUNSEL_TEXT } from './create-counsel.dto'; // [보안] 자유 텍스트 상한 단일 소스
import { CounselInstantField } from '../counsel-instant';

// [참조/처리] PATCH /counsel/:id — 상태·학생·상담 내용·예정 시각 수정. status는 계약 유니온 검사.
const STATUS = COUNSEL_STATUSES; // [P2 M5] 진실원(counsel.entity)
export class UpdateCounselDto implements Omit<UpdateCounselInput, 'source' | 'submitterType' | 'assignedStaffId'> {
  @IsOptional() @IsIn(STATUS as unknown as string[]) status?: UpdateCounselInput['status'];
  @IsOptional() @IsInt() studentId?: number;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string | null;
  @IsOptional() @CounselInstantField({ nullable: true }) nextContactAt?: string | null;
}
