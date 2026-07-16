// [B4 2026-07-16] 강의실 부분 수정 — 이름·정원·색·활성. 정원은 서버 충돌 정책 입력이라 0 이상 강제.
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateRoomDto {
  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional() @IsString() @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ example: 1, description: '정원(수용 학생 수) — 기본 1명' })
  @IsOptional() @IsInt() @Min(1) @Max(200)
  capacity?: number;

  @ApiPropertyOptional({ example: '#0969da' })
  @IsOptional() @IsString() @MaxLength(20)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsBoolean()
  isActive?: boolean;
}
