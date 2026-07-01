import { IsInt, IsOptional, IsString, MaxLength, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// POST /reports — 수업 1회 학생별 보고서 작성. 세션 FK·(세션,학생) 중복·강사 일치 검증.
export class CreateReportDto {
  @ApiProperty({ example: 1, description: '수업 세션 FK(class_sessions.id)' })
  @IsInt()
  sessionId!: number;

  @ApiProperty({ example: 1, description: '학생 FK(students.id)' })
  @IsInt()
  studentId!: number;

  @ApiPropertyOptional({ example: 1, description: '강사 FK(미지정 시 세션 강사로 채움)' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiProperty({ example: '오늘 진도: 추론 문제 3세트. 정답률 향상.', description: '보고서 본문(진도·피드백)' })
  @IsString() @MaxLength(4000)
  content!: string;

  @ApiPropertyOptional({ example: '워크북 12–15p', description: '숙제(선택)' })
  @IsOptional() @IsString() @MaxLength(2000)
  homework?: string;

  @ApiPropertyOptional({ enum: ['draft', 'submitted'], description: '기본 submitted(승인요청). draft 허용' })
  @IsOptional() @IsIn(['draft', 'submitted'])
  status?: 'draft' | 'submitted';
}
