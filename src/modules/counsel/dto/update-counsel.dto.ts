import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { UpdateCounselInput } from '@kms545487/contracts';
import { COUNSEL_DATE, COUNSEL_TEXT, SOURCES, SUBMITTERS } from './create-counsel.dto'; // [보안] 자유 텍스트 상한 단일 소스

// [참조/처리] PATCH /counsel/:id — 상태 전환·담당자·관심사 수정. status는 계약 유니온 검사.
const STATUS = ['requested', 'pending', 'registered', 'dropped'] as const;
export class UpdateCounselDto implements UpdateCounselInput {
  @IsOptional() @IsIn(STATUS as unknown as string[]) status?: UpdateCounselInput['status'];
  @IsOptional() @IsIn(SOURCES as unknown as string[]) source?: UpdateCounselInput['source'];
  @IsOptional() @IsIn(SUBMITTERS as unknown as string[]) submitterType?: UpdateCounselInput['submitterType'];
  @IsOptional() @IsInt() studentId?: number;
  @IsOptional() @IsInt() assignedStaffId?: number | null;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.referenceNotes) referenceNotes?: string | null;
  @IsOptional() @Matches(COUNSEL_DATE, { message: 'nextContactAt must be YYYY-MM-DD' }) nextContactAt?: string | null;
}
