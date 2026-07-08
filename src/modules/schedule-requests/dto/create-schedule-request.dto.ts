import { IsDefined, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, Max, IsArray, ArrayMaxSize, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AvailabilityKind, AvailabilityOwner, SessionKind, CreateScheduleRequestInput } from '@kms545487/contracts';
import { SESSION_KINDS } from '../../schedule/dto/create-schedule.dto';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
type RequestKind = 'session_create' | 'availability_upsert' | 'availability_delete';
type AvailabilityKindEx = AvailabilityKind | 'online_only';
const REQUEST_KINDS: RequestKind[] = ['session_create', 'availability_upsert', 'availability_delete'];
const AVAILABILITY_KINDS: AvailabilityKindEx[] = ['available', 'unavailable', 'online_only'];
const OWNER_TYPES: AvailabilityOwner[] = ['student', 'instructor', 'room'];

const isSessionCreate = (o: CreateScheduleRequestDto): boolean => !o.requestKind || o.requestKind === 'session_create';
const isAvailabilityUpsert = (o: CreateScheduleRequestDto): boolean => o.requestKind === 'availability_upsert';
const isAvailabilityDelete = (o: CreateScheduleRequestDto): boolean => o.requestKind === 'availability_delete';
const isAvailabilityRequest = (o: CreateScheduleRequestDto): boolean => isAvailabilityUpsert(o) || isAvailabilityDelete(o);

// 강사 수업 요청(승인 대기) 생성 — 세션 생성과 동일 검증 규약(FK·코호트·시간 형식).
// [v0.1.14] implements CreateScheduleRequestInput — contracts drift를 tsc가 강제.
export class CreateScheduleRequestDto implements CreateScheduleRequestInput {
  @ApiPropertyOptional({ enum: REQUEST_KINDS, example: 'session_create', description: '요청 종류(기본 session_create)' })
  @IsOptional() @IsIn(REQUEST_KINDS)
  requestKind?: RequestKind;

  @ApiPropertyOptional({ example: 10, description: '코스 FK(session_create 필수)' })
  @ValidateIf(isSessionCreate)
  @IsInt()
  courseId!: number;

  @ApiPropertyOptional({ example: 1, description: '수업 강사 FK(미지정=코스 기본 강사 — 요청 시 본인)' })
  @IsOptional() @IsInt()
  instructorId?: number;

  @ApiPropertyOptional({ example: 2, description: '강의실 FK' })
  @IsOptional() @IsInt()
  roomId?: number;

  @ApiPropertyOptional({ example: '2026-07-10', description: 'session_create 필수' })
  @ValidateIf(isSessionCreate)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  sessionDate!: string;

  @ApiPropertyOptional({ example: '16:00', description: 'HH:mm — KST 단일 진실원(session_create 필수)' })
  @ValidateIf(isSessionCreate)
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

  @ApiPropertyOptional({ example: 3, description: 'availability_delete 또는 availability_upsert 수정 대상 블록 id' })
  @ValidateIf((o) => isAvailabilityRequest(o) && (isAvailabilityDelete(o) || o.targetAvailabilityId != null))
  @IsDefined() @IsInt()
  targetAvailabilityId?: number;

  @ApiPropertyOptional({ enum: OWNER_TYPES, example: 'instructor', description: 'availability_upsert 필수' })
  @ValidateIf(isAvailabilityUpsert)
  @IsIn(OWNER_TYPES)
  availabilityOwnerType?: AvailabilityOwner;

  @ApiPropertyOptional({ example: 1, description: 'availability_upsert 필수' })
  @ValidateIf(isAvailabilityUpsert)
  @IsInt()
  availabilityOwnerId?: number;

  @ApiPropertyOptional({ enum: AVAILABILITY_KINDS, example: 'unavailable', description: 'availability_upsert 필수' })
  @ValidateIf(isAvailabilityUpsert)
  @IsIn(AVAILABILITY_KINDS)
  availabilityKind?: AvailabilityKindEx;

  @ApiPropertyOptional({ example: 1, minimum: 0, maximum: 6, description: 'availability_upsert 필수(0=일)' })
  @ValidateIf(isAvailabilityUpsert)
  @IsInt() @Min(0) @Max(6)
  availabilityWeekday?: number;

  @ApiPropertyOptional({ example: '16:00', description: 'availability_upsert 필수' })
  @ValidateIf(isAvailabilityUpsert)
  @Matches(HHMM, { message: 'availabilityStartTime must be HH:mm' })
  availabilityStartTime?: string;

  @ApiPropertyOptional({ example: '18:00', description: 'availability_upsert 필수' })
  @ValidateIf(isAvailabilityUpsert)
  @Matches(HHMM, { message: 'availabilityEndTime must be HH:mm' })
  availabilityEndTime?: string;

  @ApiPropertyOptional({ example: '2026-07-01' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  availabilityEffectiveFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  availabilityEffectiveTo?: string;
}
