import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import type { SessionStatus, RecurrenceScope } from '@kms545487/contracts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SessionStatus[] = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'];
const SCOPES: RecurrenceScope[] = ['this', 'this_and_following', 'all'];

// 이동·리사이즈·상세편집 공용 부분수정 DTO. (추후 contracts UpdateClassSessionInput로 승격 가능)
export class UpdateScheduleDto {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate?: string;

  @IsOptional() @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime?: string;

  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @IsOptional() @IsInt() @Min(10)
  durationMinutes?: number;

  @IsOptional() @IsInt()
  roomId?: number;

  @IsOptional() @IsInt()
  instructorId?: number;

  @IsOptional() @IsInt()
  courseId?: number;

  @IsOptional() @IsIn(STATUSES)
  status?: SessionStatus;

  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;

  // 반복 편집 범위(구글 캘린더식). this=이 일정만, this_and_following=이후 전부, all=시리즈 전체.
  // 같은 seriesId의 다른 세션들에 동일한 날짜·시간 델타(+절대 강의실/강사/상태)를 적용. 기본 'this'.
  @IsOptional() @IsIn(SCOPES)
  scope?: RecurrenceScope;

  // 충돌이 있어도 적용할지(구글 캘린더식 "그래도 진행"). 기본 false → 충돌 시 409.
  @IsOptional()
  force?: boolean;
}
