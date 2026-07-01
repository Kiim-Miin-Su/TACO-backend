import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionStatus, RecurrenceScope } from '@kms545487/contracts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SessionStatus[] = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'];
const SCOPES: RecurrenceScope[] = ['this', 'this_and_following', 'all'];

// PATCH /schedule/:id — 이동·리사이즈·상세편집 공용 부분수정 DTO. 모든 필드 선택.
export class UpdateScheduleDto {
  @ApiPropertyOptional({ example: '2026-07-02', description: '이동할 날짜(YYYY-MM-DD)' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate?: string;

  @ApiPropertyOptional({ example: '15:00', description: '시작(HH:mm)' })
  @IsOptional() @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({ example: '16:00', description: '종료(HH:mm)' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 60 })
  @IsOptional() @IsInt() @Min(10)
  durationMinutes?: number;

  @ApiPropertyOptional({ description: '강의실 FK' })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiPropertyOptional({ description: '강사 FK' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ description: '코스 FK' })
  @IsOptional() @IsInt()
  courseId?: number;

  @ApiPropertyOptional({ enum: STATUSES, description: '상태(취소/결강 등)' })
  @IsOptional() @IsIn(STATUSES)
  status?: SessionStatus;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;

  @ApiPropertyOptional({ description: '캘린더 색상 라벨' })
  @IsOptional() @IsString() @MaxLength(20)
  color?: string;

  @ApiPropertyOptional({ enum: SCOPES, description: '반복 편집 범위: this=이 일정만, this_and_following=이후 전부, all=시리즈 전체(기본 this)' })
  @IsOptional() @IsIn(SCOPES)
  scope?: RecurrenceScope;

  @ApiPropertyOptional({ description: '충돌이 있어도 강제 적용(기본 false → 충돌 시 409)' })
  @IsOptional() @IsBoolean()
  force?: boolean;
}
