import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, IsArray, ArrayMaxSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionStatus, SessionKind, CreateClassSessionInput } from '@kms545487/contracts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES: SessionStatus[] = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'];
export const SESSION_KINDS: SessionKind[] = ['class', 'level_test', 'counsel'];

// 세션 생성(추천→배정·수동 추가) DTO. courseId+시작시각 필수, 강사/강의실은 선택(코스 기본 강사 사용).
// [v0.1.14] implements CreateClassSessionInput — contracts 필드 drift를 tsc가 강제(감사 A1 해소).
export class CreateScheduleDto implements CreateClassSessionInput {
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

  // [R-9 2026-07-06] endTime < startTime = 익일 종료(자정 크로스)로 해석 — 서비스가 durationMinutes로 저장(파생)
  @ApiPropertyOptional({ example: '17:30', description: '미지정 시 start+duration 파생. startTime보다 이르면 익일 종료(자정 크로스)' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 90, description: 'endTime 없을 때 사용(기본 60)' })
  @IsOptional() @IsInt() @Min(10) @Max(480) // [감사 H4] 상한 8h — 시급 계산 오염 방지
  durationMinutes?: number;

  @ApiPropertyOptional({ description: '명시 코호트(v0.1.13) — 미지정=코스 활성 수강생 전원. 지정 시 그 코스 활성 수강생의 부분집합만 허용', type: [Number] })
  @IsOptional() @IsArray() @IsInt({ each: true }) @ArrayMaxSize(20)
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
  @IsOptional() @IsInt() @Min(0) @Max(100_000_000) // 금액 규칙 통일(@Max 1e8)
  price?: number;
}
