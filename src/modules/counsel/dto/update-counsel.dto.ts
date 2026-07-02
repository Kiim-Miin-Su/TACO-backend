import { IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import type { UpdateCounselInput } from '@kms545487/contracts';

// [참조/처리] PATCH /counsel/:id — 상태 전환·담당자·관심사 수정. status는 계약 유니온 검사.
const STATUS = ['requested', 'pending', 'registered', 'dropped'] as const;

export class UpdateCounselDto implements UpdateCounselInput {
  @IsOptional() @IsIn(STATUS as unknown as string[]) status?: UpdateCounselInput['status'];
  @IsOptional() @IsInt() assignedStaffId?: number;
  @IsOptional() @IsInt() interestSubjectId?: number;
  @IsOptional() @IsInt() interestCourseId?: number;
  @IsOptional() @IsString() academyExpectation?: string;
  @IsOptional() @IsString() weakness?: string;
}
