import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { StudentInterestInput } from '@kms545487/contracts';

export class StudentInterestDto implements StudentInterestInput {
  @ApiPropertyOptional({ description: '기존 course 선택. customLabel과 정확히 하나만 허용' })
  @IsOptional()
  @IsInt()
  @Min(1)
  courseId?: number;

  @ApiPropertyOptional({ description: '카탈로그 외 희망 수업. courseId와 정확히 하나만 허용', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  customLabel?: string;

  @ApiProperty({ description: '1부터 시작하는 연속 우선순위', minimum: 1 })
  @IsInt()
  @Min(1)
  priority!: number;
}
