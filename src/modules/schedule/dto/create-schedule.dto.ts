import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionStatus } from '@kms545487/contracts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SessionStatus[] = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'];

// 세션 생성(추천→배정·수동 추가) DTO. courseId+시작시각 필수, 강사/강의실은 선택(코스 기본 강사 사용).
export class CreateScheduleDto {
  @ApiProperty({ example: 10, description: '코스 FK(필수)' })
  @IsInt()
  courseId!: number;

  @ApiPropertyOptional({ example: 1, description: '강사 FK(미지정 시 코스 기본 강사)' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ example: 2, description: '강의실 FK' })
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
  @IsOptional() @IsInt() @Min(10) @Max(480) // [감사 H4] 상한 8h — 시급 계산 오염 방지
  durationMinutes?: number;

  @ApiPropertyOptional({ example: 'Reading: 추론 문제 전략', description: '수업 주제' })
  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @ApiPropertyOptional({ example: '교재 3장 지참', description: '메모' })
  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;

  @ApiPropertyOptional({ example: '#0969da', description: '캘린더 색상 라벨(미지정 시 코스 색)' })
  @IsOptional() @IsString() @MaxLength(20)
  color?: string;

  @ApiPropertyOptional({ example: 1719800000000, description: '반복 시리즈로 묶을 때(같은 seriesId)' })
  @IsOptional() @IsInt()
  seriesId?: number;

  @ApiPropertyOptional({ enum: STATUSES, example: 'scheduled' })
  @IsOptional() @IsIn(STATUSES)
  status?: SessionStatus;

  @ApiPropertyOptional({ example: false, description: '충돌이 있어도 강제 적용(기본 false → 충돌 시 409)' })
  @IsOptional() @IsBoolean()
  force?: boolean;
}
