import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDefined, IsInt, IsOptional, IsString, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import type { UpdateSessionInstructorAssignmentInput } from '@kms545487/contracts';

export class UpdateSessionInstructorAssignmentDto implements UpdateSessionInstructorAssignmentInput {
  @ApiProperty({ nullable: true, example: 7, description: 'null=배정중, 숫자=담당 강사' })
  @IsDefined()
  @ValidateIf((_object, value) => value !== null)
  @IsInt() @Min(1)
  instructorId!: number | null;

  @ApiProperty({ example: '담당 가능 강사 확정', minLength: 5, maxLength: 500 })
  @IsString() @MinLength(5) @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ nullable: true, example: null, description: '현재 담당자 CAS. null은 현재도 배정중이어야 함' })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsInt() @Min(1)
  expectedInstructorId?: number | null;

  @ApiPropertyOptional({ example: false, description: '같은 transaction에서 코스 기본 담당자도 갱신' })
  @IsOptional() @IsBoolean()
  setCourseDefault?: boolean;
}
