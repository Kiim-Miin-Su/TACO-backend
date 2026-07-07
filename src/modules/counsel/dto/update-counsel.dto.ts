import { IsIn, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import type { UpdateCounselInput } from '@kms545487/contracts';
import { COUNSEL_TEXT } from './create-counsel.dto'; // [보안] 자유 텍스트 상한 단일 소스

// [참조/처리] PATCH /counsel/:id — 상태 전환·담당자·관심사 수정. status는 계약 유니온 검사.
const STATUS = ['requested', 'pending', 'registered', 'dropped'] as const;

export class UpdateCounselDto implements UpdateCounselInput {
  @IsOptional() @IsIn(STATUS as unknown as string[]) status?: UpdateCounselInput['status'];
  @IsOptional() @IsInt() assignedStaffId?: number;
  @IsOptional() @IsInt() interestSubjectId?: number;
  @IsOptional() @IsInt() interestCourseId?: number;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.expectation) academyExpectation?: string;
  @IsOptional() @IsString() @MaxLength(COUNSEL_TEXT.weakness) weakness?: string;
}
