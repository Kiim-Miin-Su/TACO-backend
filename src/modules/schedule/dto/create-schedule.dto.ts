import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, IsArray, ArrayMaxSize, ArrayUnique } from 'class-validator';
import { SESSION_STATUSES } from '../schedule.entity'; // [P2 M5]
import { SESSION_MAX_MIN, SESSION_MIN_MIN } from '../session-time.policy'; // [P2 M7] 분 상한 단일 진실원
import { MAX_AMOUNT } from '../../../common/validation-limits'; // [P2 M6]
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionStatus, SessionKind, SessionMode, CreateClassSessionInput } from '@kms545487/contracts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = SESSION_STATUSES; // [P2 M5] 런타임 배열 진실원(schedule.entity)
export const SESSION_KINDS: SessionKind[] = ['class', 'level_test', 'counsel'];
export const SESSION_MODES: SessionMode[] = ['in_person', 'online']; // [v0.1.16] 수업방식

// 세션 생성(추천→배정·수동 추가) DTO. courseId+시작시각 필수, 강사/강의실은 선택(코스 기본 강사 사용).
// [v0.1.14] implements CreateClassSessionInput — contracts 필드 drift를 tsc가 강제(감사 A1 해소).
export class CreateScheduleDto implements CreateClassSessionInput {
  @ApiProperty({ example: 10, description: '코스 FK(필수)' })
  @IsInt()
  courseId!: number;

  @ApiPropertyOptional({ nullable: true, example: 1, description: 'undefined=코스 기본 강사, null=배정중, 숫자=지정 강사' })
  @IsOptional() @IsInt()
  instructorId?: number | null;

  @ApiPropertyOptional({ example: 2, description: '강의실 FK' })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiProperty({ example: '2026-06-30' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate!: string;

  @ApiProperty({ example: '16:00' })
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  // [R-9 2026-07-06] endTime < startTime = 익일 종료(자정 크로스)로 해석 — 서비스가 durationMinutes로 저장(파생)
  @ApiPropertyOptional({ example: '17:30', description: '미지정 시 start+duration 파생. startTime보다 이르면 익일 종료(자정 크로스)' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 90, description: 'endTime 없을 때 사용(기본 60)' })
  @IsOptional() @IsInt() @Min(SESSION_MIN_MIN) @Max(SESSION_MAX_MIN) // [감사 H4] 상한 8h — 시급 계산 오염 방지
  durationMinutes?: number;

  @ApiPropertyOptional({ description: '명시 참가자 snapshot — 과목/수강과 독립. 미지정은 legacy roster fallback 전용', type: [Number] })
  @IsOptional() @IsArray() @ArrayUnique() @IsInt({ each: true }) @ArrayMaxSize(20)
  studentIds?: number[];

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

  @ApiPropertyOptional({ enum: SESSION_KINDS, example: 'class', description: '[v0.1.14] 세션 종류(기본 class) — 진단고사/상담 분류(캘린더 필터 축)' })
  @IsOptional() @IsIn(SESSION_KINDS)
  kind?: SessionKind;

  @ApiPropertyOptional({ example: 50000, description: '[v0.1.14] 세션 단건 가격(원) — 상담(kind=counsel) 등. 코스 정가와 별개' })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) // 금액 규칙 통일 — 단일 진실원(P2 M6)
  price?: number;

  @ApiPropertyOptional({ enum: SESSION_MODES, example: 'in_person', description: '[v0.1.16] 수업방식(기본 in_person) — 대면/비대면. 강의실 유무와 독립' })
  @IsOptional() @IsIn(SESSION_MODES)
  mode?: SessionMode;

  @ApiPropertyOptional({ example: false, description: '공통 일정 여부. true면 전 직원 조회 가능하나 수정 권한은 확장되지 않음' })
  @IsOptional() @IsBoolean()
  isPublic?: boolean;

  @ApiPropertyOptional({ example: 24, description: '[대표 지시 ⑭ 2026-07-16] 보강 세션이 가리키는 원본(결강) 세션 id — 지정 시 원본 실존 검증, 보강 미해소 뱃지가 해소로 판정' })
  @IsOptional() @IsInt() @Min(1)
  makeupForSessionId?: number;
}
