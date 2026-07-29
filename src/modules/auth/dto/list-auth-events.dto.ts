import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';
import type { AuthEventQuery } from '@kms545487/contracts';
import { AUTH_EVENT_TYPES } from '../auth-events.service';

export class ListAuthEventsQueryDto implements AuthEventQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  userId?: number;

  @IsOptional() @IsIn(AUTH_EVENT_TYPES)
  eventType?: AuthEventQuery['eventType'];

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' ? true : value === false || value === 'false' ? false : value)
  @IsBoolean()
  success?: boolean;

  @IsOptional() @IsISO8601({ strict: true })
  from?: string;

  @IsOptional() @IsISO8601({ strict: true })
  to?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;
}
