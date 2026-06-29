import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import type { UpsertAvailabilityInput, AvailabilityOwner, AvailabilityKind } from '@kms545487/contracts';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpsertAvailabilityDto implements UpsertAvailabilityInput {
  @IsOptional()
  @IsInt()
  id?: number;

  @IsIn(['student', 'instructor', 'room'])
  ownerType!: AvailabilityOwner;

  @IsInt()
  ownerId!: number;

  @IsOptional()
  @IsIn(['available', 'unavailable'])
  kind?: AvailabilityKind;

  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime!: string;

  @IsOptional()
  @IsString()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  effectiveTo?: string;
}
