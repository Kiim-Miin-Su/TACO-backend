// [참조/처리] POST /events 바디 검증 DTO(계약 CreateEventInput 구현).
//  - type/priority는 계약 유니온과 동일 리스트로 IsIn 검사, 날짜는 YYYY-MM-DD 형식 강제(Matches).
//  - 구간 무결성(end≥start)은 형식 검증 밖이라 EventsService.create에서 별도 400 처리.
import { IsBoolean, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { CreateEventInput } from '@kms545487/contracts';
import { EventType, EventPriority } from '../event.entity';

const TYPES: EventType[] = ['notice', 'exam', 'holiday', 'closure', 'event'];
const PRIORITIES: EventPriority[] = ['low', 'normal', 'high'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEventDto implements CreateEventInput {
  @IsString()
  title!: string;

  @IsIn(TYPES)
  type!: EventType;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: EventPriority; // 기본 normal

  @Matches(ISO_DATE, { message: 'startDate must be YYYY-MM-DD' })
  startDate!: string;

  @Matches(ISO_DATE, { message: 'endDate must be YYYY-MM-DD' })
  endDate!: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @IsOptional()
  @IsString()
  memo?: string;
}
