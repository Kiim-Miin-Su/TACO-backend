import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionStatus } from '@kms545487/contracts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SessionStatus[] = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'];

// 세션 생성(추천→배정·수동 추가) DTO. courseId+시작시각 필수, 강사/강의실은 선택(코스 기본 강사 사용).
export class CreateScheduleDto {
  @ApiProperty({ example: 10, description: '코스 FK(필수)' })
  @IsInt()
  courseId!: number;

  @ApiPropertyOptional({ description: '강사 FK(미지정 시 코스 기본 강사)' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ description: '강의실 FK' })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiProperty({ example: '2026-06-30' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate!: string;

  @ApiProperty({ example: '16:00' })
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @ApiPropertyOptional({ example: '17:30', description: '미지정 시 start+duration 파생' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 90, description: 'endTime 없을 때 사용(기본 60)' })
  @IsOptional() @IsInt() @Min(10)
  durationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;

  @ApiPropertyOptional({ description: '반복 시리즈로 묶을 때' })
  @IsOptional() @IsInt()
  seriesId?: number;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional() @IsIn(STATUSES)
  status?: SessionStatus;

  @ApiPropertyOptional({ description: '충돌이 있어도 강제 적용(기본 false → 충돌 시 409)' })
  @IsOptional() @IsBoolean()
  force?: boolean;
}
