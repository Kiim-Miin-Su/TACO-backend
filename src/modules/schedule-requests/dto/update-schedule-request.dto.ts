import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, IsArray, ArrayMaxSize } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { AvailabilityKind, RecurrenceScope, SessionKind, SessionMode } from '@kms545487/contracts';
import { SESSION_KINDS } from '../../schedule/dto/create-schedule.dto';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
type AvailabilityKindEx = AvailabilityKind | 'online_only';
const AVAILABILITY_KINDS: AvailabilityKindEx[] = ['available', 'unavailable', 'online_only'];
const SESSION_MODES: SessionMode[] = ['in_person', 'online'];
const RECURRENCE_SCOPES: RecurrenceScope[] = ['this', 'this_and_following', 'all'];

// [C2C-b 청크2] pending 요청 수정(관리자 전용) — 전 필드 optional.
//  불변 필드(요청 종류·대상 블록·availability owner)는 DTO에 없음 → 전역 forbidNonWhitelisted가 400으로 차단.
//  검증은 서비스에서 생성 경로와 동일 함수 재사용(validateSessionInput / validateRequestableUpsert).
export class UpdateScheduleRequestDto {
  @ApiPropertyOptional({ example: 10, description: '코스 FK — 변경 시 기본 강사 재해석(생성과 동일)' })
  @IsOptional() @IsInt()
  courseId?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiPropertyOptional({ example: '2026-07-10' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate?: string;

  @ApiPropertyOptional({ example: '16:00' })
  @IsOptional() @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @ApiPropertyOptional({ example: '17:30' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 90 })
  @IsOptional() @IsInt() @Min(10) @Max(480)
  durationMinutes?: number;

  @ApiPropertyOptional({ type: [Number], description: '명시 코호트 — 세션과 동일 부분집합 검증' })
  @IsOptional() @IsArray() @IsInt({ each: true }) @ArrayMaxSize(20)
  studentIds?: number[];

  @ApiPropertyOptional({ example: 'Writing 보충' })
  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @ApiPropertyOptional({ enum: SESSION_KINDS, example: 'class' })
  @IsOptional() @IsIn(SESSION_KINDS)
  kind?: SessionKind;

  @ApiPropertyOptional({ enum: SESSION_MODES, example: 'online', description: '[C2D] 수업방식' })
  @IsOptional() @IsIn(SESSION_MODES)
  mode?: SessionMode;

  @ApiPropertyOptional({ example: '학부모 요청으로 30분 늦춰야 합니다.', description: '요청자가 제출한 사유(반려 사유와 분리)' })
  @IsOptional() @IsString() @MaxLength(500)
  requestReason?: string;

  @ApiPropertyOptional({ enum: RECURRENCE_SCOPES, example: 'this', description: 'session_update 반복 수업 적용 범위' })
  @IsOptional() @IsIn(RECURRENCE_SCOPES)
  scope?: RecurrenceScope;

  @ApiPropertyOptional({ enum: AVAILABILITY_KINDS, description: 'availability_upsert 전용' })
  @IsOptional() @IsIn(AVAILABILITY_KINDS)
  availabilityKind?: AvailabilityKindEx;

  @ApiPropertyOptional({ example: 1, minimum: 0, maximum: 6 })
  @IsOptional() @IsInt() @Min(0) @Max(6)
  availabilityWeekday?: number;

  @ApiPropertyOptional({ example: '14:00' })
  @IsOptional() @Matches(HHMM, { message: 'availabilityStartTime must be HH:mm' })
  availabilityStartTime?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional() @Matches(HHMM, { message: 'availabilityEndTime must be HH:mm' })
  availabilityEndTime?: string;

  @ApiPropertyOptional({ example: '2026-07-01' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  availabilityEffectiveFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  availabilityEffectiveTo?: string;
}
