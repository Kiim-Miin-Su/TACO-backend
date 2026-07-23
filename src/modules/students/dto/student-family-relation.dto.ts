import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { CreateStudentFamilyRelationInput, UpdateStudentFamilyRelationInput } from '@kms545487/contracts';

export class CreateStudentFamilyRelationDto implements CreateStudentFamilyRelationInput {
  @IsInt() @Min(1) relatedStudentId!: number;
  @IsIn(['sibling', 'other']) relationType!: 'sibling' | 'other';
  @IsOptional() @IsString() @MaxLength(50) relationLabel?: string;
  /** [TBO-30G] true면 같은 tx에서 두 학생의 보호자를 관계 행(join)으로 합집합 연결 —
   *  보호자 원부 복사 0, 신규 링크는 비대표·비납부(기존 대표 불변), 중복 연결은 건너뜀. */
  @IsOptional() @IsBoolean() linkGuardians?: boolean;
}

export class UpdateStudentFamilyRelationDto implements UpdateStudentFamilyRelationInput {
  @IsOptional() @IsIn(['sibling', 'other']) relationType?: 'sibling' | 'other';
  @IsOptional() @IsString() @MaxLength(50) relationLabel?: string;
}
