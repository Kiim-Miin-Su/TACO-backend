import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, IsBoolean, Max, IsArray, ArrayMaxSize } from 'class-validator';
import { SESSION_STATUSES, INSTRUCTOR_ATT_STATUSES } from '../schedule.entity'; // [P2 M5]
import { SESSION_MAX_MIN, SESSION_MIN_MIN } from '../session-time.policy'; // [P2 M7] 분 상한 단일 진실원
import { MAX_AMOUNT } from '../../../common/validation-limits'; // [P2 M6]
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionStatus, RecurrenceScope, InstructorAttendanceStatus, SessionKind, SessionMode, UpdateClassSessionInput } from '@kms545487/contracts';
import { SESSION_KINDS, SESSION_MODES } from './create-schedule.dto';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = SESSION_STATUSES; // [P2 M5]
const SCOPES: RecurrenceScope[] = ['this', 'this_and_following', 'all'];
const INSTRUCTOR_ATT = INSTRUCTOR_ATT_STATUSES; // [P2 M5]

// PATCH /schedule/:id — 이동·리사이즈·상세편집 공용 부분수정 DTO. 모든 필드 선택.
// [v0.1.14] implements UpdateClassSessionInput — contracts 필드 drift를 tsc가 강제(감사 A1 해소).
// [TBO-64 2026-07-24] 회차 가격 책정 — 시수 워크시트에서 매니저/대표가 금액 확정(null=해제).
export class SetSessionPayAmountDto {
  @ApiPropertyOptional({ example: 60000, description: '회차 확정 금액(원, 0 이상 정수) — null이면 책정 해제', nullable: true })
  @IsOptional() @IsInt() @Min(0)
  amount?: number | null;
}

// [TBO-62 ④ 2026-07-24] 강사 본인 출결 체크 전용 — status 하나만 받는다(수정·삭제는 매니저 이상 PATCH).
export class MarkInstructorAttendanceDto {
  @ApiPropertyOptional({ enum: INSTRUCTOR_ATT, example: 'present', description: '강사 출결(출석/지각/결석/보강)' })
  @IsIn(INSTRUCTOR_ATT)
  status!: InstructorAttendanceStatus;
}

export class UpdateScheduleDto implements UpdateClassSessionInput {
  @ApiPropertyOptional({ example: '2026-07-02', description: '이동할 날짜(YYYY-MM-DD)' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate?: string;

  @ApiPropertyOptional({ example: '15:00', description: '시작(HH:mm)' })
  @IsOptional() @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime?: string;

  // [R-9 2026-07-06] endTime < startTime = 익일 종료(자정 크로스)로 해석 — 서비스가 durationMinutes로 저장(파생)
  @ApiPropertyOptional({ example: '16:00', description: '종료(HH:mm). startTime보다 이르면 익일 종료(자정 크로스)' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 60 })
  @IsOptional() @IsInt() @Min(SESSION_MIN_MIN) @Max(SESSION_MAX_MIN) // [감사 H4] 상한 8h — 시급 계산 오염 방지
  durationMinutes?: number;

  @ApiPropertyOptional({ description: '명시 코호트(v0.1.13) — 미지정=코스 활성 수강생 전원. 지정 시 그 코스 활성 수강생의 부분집합만 허용', type: [Number] })
  @IsOptional() @IsArray() @IsInt({ each: true }) @ArrayMaxSize(20)
  studentIds?: number[];

  @ApiPropertyOptional({ example: 2, description: '강의실 FK' })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiPropertyOptional({ example: 1, description: '강사 FK' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ example: 10, description: '코스 FK' })
  @IsOptional() @IsInt()
  courseId?: number;

  @ApiPropertyOptional({ enum: STATUSES, example: 'canceled', description: '상태(취소/결강 등)' })
  @IsOptional() @IsIn(STATUSES)
  status?: SessionStatus;

  @ApiPropertyOptional({ example: 'Reading: 근거 문장 매칭' })
  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @ApiPropertyOptional({ example: '워크북 지참' })
  @IsOptional() @IsString() @MaxLength(500)
  memo?: string;

  @ApiPropertyOptional({ example: '#9a6700', description: '캘린더 색상 라벨' })
  @IsOptional() @IsString() @MaxLength(20)
  color?: string;

  @ApiPropertyOptional({ enum: INSTRUCTOR_ATT, example: 'present', description: '강사 출결(출석/지각/결석/보강)' })
  @IsOptional() @IsIn(INSTRUCTOR_ATT)
  instructorAttendance?: InstructorAttendanceStatus;

  // [TBO-19 Sprint2] 강사 출결 초기화(미표시로) — true면 instructorAttendance를 비운다(`?? cur` 우회).
  @ApiPropertyOptional({ example: false, description: '강사 출결을 미표시로 초기화(clear)' })
  @IsOptional() @IsBoolean()
  clearInstructorAttendance?: boolean;

  @ApiPropertyOptional({ enum: SCOPES, example: 'this', description: '반복 편집 범위: this=이 일정만, this_and_following=이후 전부, all=시리즈 전체(기본 this)' })
  @IsOptional() @IsIn(SCOPES)
  scope?: RecurrenceScope;

  @ApiPropertyOptional({ example: 1, description: '[TBO-29C C3] series edit CAS — 클라이언트가 본 seriesVersion. 불일치 시 409 SERIES_VERSION_STALE' })
  @IsOptional() @IsInt() @Min(1)
  expectedSeriesVersion?: number;

  @ApiPropertyOptional({ example: false, description: '충돌이 있어도 강제 적용(기본 false → 충돌 시 409)' })
  @IsOptional() @IsBoolean()
  force?: boolean;

  @ApiPropertyOptional({ example: false, description: '완료 수업의 시수·정산 예상 변화 확인 후 적용 동의' })
  @IsOptional() @IsBoolean()
  acknowledgeAccountingImpact?: boolean;

  // [74D-0] ack를 "사용자가 본 영향"에 결속 — 직전 409의 impactHash를 회신해야 적용된다(삭제와 동일 규약).
  @ApiPropertyOptional({ example: 'a1b2…(64 hex)', description: '[74D-0] 직전 409 ACCOUNTING_IMPACT_ACK_REQUIRED의 impactHash — ack는 이 지문과 일치할 때만 유효' })
  @IsOptional() @Matches(/^[a-f0-9]{64}$/, { message: 'expectedAccountingImpactHash는 64자리 sha256 hex여야 합니다' })
  expectedAccountingImpactHash?: string;

  @ApiPropertyOptional({ enum: SESSION_KINDS, example: 'counsel', description: '[v0.1.14] 세션 종류 변경' })
  @IsOptional() @IsIn(SESSION_KINDS)
  kind?: SessionKind;

  @ApiPropertyOptional({ example: 50000, description: '[v0.1.14] 세션 단건 가격(원)' })
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) // [P2 M6]
  price?: number;

  @ApiPropertyOptional({ enum: SESSION_MODES, example: 'online', description: '[v0.1.16] 수업방식 변경(대면/비대면)' })
  @IsOptional() @IsIn(SESSION_MODES)
  mode?: SessionMode;

  @ApiPropertyOptional({ example: true, description: '공통 일정 조회 공개 여부' })
  @IsOptional() @IsBoolean()
  isPublic?: boolean;
}
