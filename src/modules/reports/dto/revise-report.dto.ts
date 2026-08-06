import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import type { ReviseApprovedSessionReportInput } from '@kms545487/contracts';

export class ReviseApprovedReportDto implements ReviseApprovedSessionReportInput {
  @ApiProperty({ example: 2, description: '화면에서 확인한 현재 본문 version' })
  @IsInt() @Min(1)
  expectedVersion!: number;

  @ApiProperty({ example: '학부모 전달 전 표현 보완', description: '승인 후 수정 사유' })
  @IsString() @MinLength(1) @MaxLength(1000)
  reason!: string;

  @ApiProperty({ description: '수정할 수업 내용' })
  @IsString() @MaxLength(4000)
  content!: string;

  @ApiPropertyOptional({ description: '수정할 진도 페이지. 빈 문자열은 비움.' })
  @IsOptional() @IsString() @MaxLength(2000)
  progressPage?: string;

  @ApiPropertyOptional({ description: '수정할 숙제. 빈 문자열은 비움.' })
  @IsOptional() @IsString() @MaxLength(2000)
  homework?: string;
}

