// [TBO-29D 요구 ⑥] PATCH /events/:id 부분 수정 DTO — create와 동일 검증을 전 필드 optional로.
//  구간 무결성(end≥start)은 서비스가 병합 후 재검증(부분 패치로 역전되는 것 방지).
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { EventType, EventPriority } from '../event.entity';
import { TEXT } from '../../../common/validation-limits';

const TYPES: EventType[] = ['notice', 'exam', 'holiday', 'closure', 'event'];
const PRIORITIES: EventPriority[] = ['low', 'normal', 'high'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @MaxLength(TEXT.name)
  title?: string;

  @IsOptional()
  @IsIn(TYPES)
  type?: EventType;

  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: EventPriority;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'startDate must be YYYY-MM-DD' })
  startDate?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'endDate must be YYYY-MM-DD' })
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  allDay?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT.memo)
  memo?: string;
}
