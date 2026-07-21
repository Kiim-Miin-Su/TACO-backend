import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { CreateStudentFamilyRelationInput, UpdateStudentFamilyRelationInput } from '@kms545487/contracts';

export class CreateStudentFamilyRelationDto implements CreateStudentFamilyRelationInput {
  @IsInt() @Min(1) relatedStudentId!: number;
  @IsIn(['sibling', 'other']) relationType!: 'sibling' | 'other';
  @IsOptional() @IsString() @MaxLength(50) relationLabel?: string;
}

export class UpdateStudentFamilyRelationDto implements UpdateStudentFamilyRelationInput {
  @IsOptional() @IsIn(['sibling', 'other']) relationType?: 'sibling' | 'other';
  @IsOptional() @IsString() @MaxLength(50) relationLabel?: string;
}
