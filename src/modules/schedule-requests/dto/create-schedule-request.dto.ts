import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, IsArray, ArrayMaxSize } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionKind, CreateScheduleRequestInput } from '@kms545487/contracts';
import { SESSION_KINDS } from '../../schedule/dto/create-schedule.dto';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// 강사 수업 요청(승인 대기) 생성 — 세션 생성과 동일 검증 규약(FK·코호트·시간 형식).
// [v0.1.14] implements CreateScheduleRequestInput — contracts drift를 tsc가 강제.
export class CreateScheduleRequestDto implements CreateScheduleRequestInput {
  @ApiProperty({ example: 10, description: '코스 FK(필수)' })
  @IsInt()
  courseId!: number;

  @ApiPropertyOptional({ example: 1, description: '수업 강사 FK(미지정=코스 기본 강사 — 요청 시 본인)' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ example: 2, description: '강의실 FK' })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiProperty({ example: '2026-07-10' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate!: string;

  @ApiProperty({ example: '16:00', description: 'HH:mm — KST 단일 진실원(세션과 동일 규약)' })
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @ApiPropertyOptional({ example: '17:30' })
  @IsOptional() @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime?: string;

  @ApiPropertyOptional({ example: 90, description: 'endTime 없을 때 사용(기본 60)' })
  @IsOptional() @IsInt() @Min(10) @Max(480) // 세션과 동일 상한(8h — 시급 계산 오염 방지)
  durationMinutes?: number;

  @ApiPropertyOptional({ description: '명시 코호트 — 코스 활성 수강생 부분집합(세션과 동일 검증)', type: [Number] })
  @IsOptional() @IsArray() @IsInt({ each: true }) @ArrayMaxSize(20)
  studentIds?: number[];

  @ApiPropertyOptional({ example: 'Writing 보충', description: '수업 주제' })
  @IsOptional() @IsString() @MaxLength(200)
  topic?: string;

  @ApiPropertyOptional({ enum: SESSION_KINDS, example: 'class' })
  @IsOptional() @IsIn(SESSION_KINDS)
  kind?: SessionKind;
}
