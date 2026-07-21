import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { UpdateStudentAggregateInput } from '@kms545487/contracts';
import { UpdateStudentDto } from './update-student.dto';
import { StudentInterestDto } from './student-interest.dto';

export class UpdateStudentAggregateDto implements UpdateStudentAggregateInput {
  @ApiPropertyOptional({ type: UpdateStudentDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateStudentDto)
  student?: UpdateStudentDto;

  @ApiPropertyOptional({ type: [StudentInterestDto], minItems: 2, maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => StudentInterestDto)
  interests?: StudentInterestDto[];
}
