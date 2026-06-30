import { IsInt, IsOptional, IsString, MaxLength, IsIn } from 'class-validator';

export class CreateReportDto {
  @IsInt()
  sessionId!: number;

  @IsInt()
  studentId!: number;

  @IsOptional() @IsInt()
  instructorId?: number; // 미지정 시 세션 강사로 채움

  @IsString() @MaxLength(4000)
  content!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  homework?: string;

  // 생성 시 바로 제출할지(기본 submitted=승인요청). draft도 허용.
  @IsOptional() @IsIn(['draft', 'submitted'])
  status?: 'draft' | 'submitted';
}
