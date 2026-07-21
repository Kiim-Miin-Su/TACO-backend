// [TBO-29C C2] 반복 생성 bulk command DTO — 단건 create loop/클라이언트 seriesId를 대체.
//  implements CreateScheduleSeriesCommand — contracts drift를 tsc가 강제(감사 A1 규약).
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString,
  Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  CreateScheduleSeriesCommand, ScheduleSeriesRepeatKind, SessionKind, SessionMode, SessionStatus,
} from '@kms545487/contracts';
import { SESSION_KINDS, SESSION_MODES } from './create-schedule.dto';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SessionStatus[] = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'];
const REPEAT_KINDS: ScheduleSeriesRepeatKind[] = ['weekly', 'custom'];

export class ScheduleSeriesRepeatDto {
  @ApiProperty({ enum: REPEAT_KINDS, example: 'weekly', description: 'weekly=시작일 요일 1개 · custom=선택 요일들' })
  @IsIn(REPEAT_KINDS)
  kind!: ScheduleSeriesRepeatKind;

  @ApiProperty({ type: [Number], example: [1, 3, 5], description: '0(일)~6(토) — 중복 없음. weekly는 1개' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ArrayUnique() @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true })
  weekdays!: number[];

  @ApiProperty({ example: '2026-07-20', description: '첫 occurrence 후보일(KST)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startsOn!: string;

  @ApiProperty({ example: '2026-08-24', description: '마지막 occurrence 후보일(KST) — startsOn <= endsOn' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endsOn!: string;
}

export class CreateScheduleSeriesDto implements CreateScheduleSeriesCommand {
  @ApiProperty({ example: 10, description: '코스 FK(필수)' })
  @IsInt()
  courseId!: number;

  @ApiPropertyOptional({ example: 1, description: '강사 FK(미지정 시 코스 기본 강사)' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ example: 2, description: '강의실 FK' })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiPropertyOptional({ description: '명시 코호트 — 미지정=코스 활성 수강생 전원. 지정 시 부분집합만 허용', type: [Number] })
  @IsOptional() @IsArray() @IsInt({ each: true }) @ArrayMaxSize(20)
  studentIds?: number[];

  @ApiProperty({ type: ScheduleSeriesRepeatDto, description: '반복 규칙 — 서버가 occurrence 날짜를 정규화·발급' })
  @ValidateNested() @Type(() => ScheduleSeriesRepeatDto)
  repeat!: ScheduleSeriesRepeatDto;

  @ApiProperty({ example: '16:00' })
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @ApiPropertyOptional({ example: '17:30', description: '미지정 시 durationMinutes 사용. startTime보다 이르면 익일 종료(자정 크로스)' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 90, description: 'endTime 없을 때 사용(기본 60)' })
  @IsOptional() @IsInt() @Min(10) @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional({ example: 'Asia/Seoul', description: '규칙 해석 기준 시간대(MVP는 Asia/Seoul 고정)' })
  @IsOptional() @IsString() @MaxLength(64)
  timeZone?: string;

  @ApiPropertyOptional({ example: 'Reading: 추론 문제 전략' })
  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @ApiPropertyOptional({ example: '교재 3장 지참' })
  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;

  @ApiPropertyOptional({ example: '#0969da' })
  @IsOptional() @IsString() @MaxLength(20)
  color?: string;

  @ApiPropertyOptional({ enum: STATUSES, example: 'scheduled' })
  @IsOptional() @IsIn(STATUSES)
  status?: SessionStatus;

  @ApiPropertyOptional({ enum: SESSION_KINDS, example: 'class' })
  @IsOptional() @IsIn(SESSION_KINDS)
  kind?: SessionKind;

  @ApiPropertyOptional({ example: 50000, description: '세션 단건 가격(상담 등)' })
  @IsOptional() @IsInt() @Min(0)
  price?: number;

  @ApiPropertyOptional({ enum: SESSION_MODES, example: 'in_person' })
  @IsOptional() @IsIn(SESSION_MODES)
  mode?: SessionMode;

  @ApiPropertyOptional({ example: false, description: '반복 회차 전체의 공통 일정 공개 여부' })
  @IsOptional() @IsBoolean()
  isPublic?: boolean;

  @ApiPropertyOptional({ example: false, description: '충돌이 있어도 강제 적용(기본 false → 전체 충돌 목록과 함께 409)' })
  @IsOptional() @IsBoolean()
  force?: boolean;
}
