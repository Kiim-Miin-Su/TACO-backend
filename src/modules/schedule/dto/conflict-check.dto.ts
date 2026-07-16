import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, Matches } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// POST /schedule/conflicts — 생성·이동 전 충돌 드라이런(강사·강의실 이중예약, 불가시간 겹침)
// [A1 2026-07-06] 드라이런 질의(저장 없음) — 엔티티 Input이 아니라 contracts 미승격(A1 제외).
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

  @ApiPropertyOptional({ type: [Number], description: '학생 가용성 검사 대상. 미지정 시 생성/수정 서비스가 코스 코호트를 사용' })
  @IsOptional() @IsArray() @IsInt({ each: true }) @ArrayMaxSize(20)
  studentIds?: number[];

  @ApiPropertyOptional({ example: 5, description: '검사에서 제외할 세션 id(자기 자신 이동 시)' })
  @IsOptional()
  @IsInt()
  ignoreSessionId?: number;

  // [E0 후속 2026-07-16, TBO-29D §5.4] mode 노출 — 서비스는 이미 받지만 DTO whitelist가 벗겨내
  //  드라이런이 online 세션의 online_only 허용(불가여도 온라인은 허용)을 표현하지 못했다.
  //  생성/수정 DTO와 동일 값 집합 — 미지정 시 conflict.util이 in_person으로 해석(하위호환).
  @ApiPropertyOptional({ enum: ['in_person', 'online'], description: '수업 방식 — online이면 online_only 불가시간과 충돌하지 않음' })
  @IsOptional()
  @IsIn(['in_person', 'online'])
  mode?: 'in_person' | 'online';
}
