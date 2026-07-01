import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Matches } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// POST /schedule/conflicts — 생성·이동 전 충돌 드라이런(강사·강의실 이중예약, 불가시간 겹침)
export class ConflictCheckDto {
  @ApiProperty({ example: '2026-06-29', description: '대상 날짜(YYYY-MM-DD)' })
  @Matches(DATE, { message: 'sessionDate must be YYYY-MM-DD' })
  sessionDate!: string;

  @ApiProperty({ example: '14:00', description: '시작(HH:mm)' })
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @ApiPropertyOptional({ example: '15:00', description: '종료(HH:mm). 미지정 시 durationMinutes로 파생' })
  @IsOptional()
  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 60, description: '진행 분(endTime 미지정 시 사용)' })
  @IsOptional()
  @IsInt()
  durationMinutes?: number;

  @ApiPropertyOptional({ example: 1, description: '강사(users.id) — 이중예약·불가시간 검사 대상' })
  @IsOptional()
  @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ example: 2, description: '강의실(rooms.id) — 이중예약·불가시간 검사 대상' })
  @IsOptional()
  @IsInt()
  roomId?: number;

  @ApiPropertyOptional({ example: 5, description: '검사에서 제외할 세션 id(자기 자신 이동 시)' })
  @IsOptional()
  @IsInt()
  ignoreSessionId?: number;
}
