import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { UpsertAvailabilityInput, AvailabilityOwner, AvailabilityKind } from '@kms545487/contracts';
import { TEXT } from '../../../common/validation-limits'; // [보안] 자유 텍스트 상한 단일 소스

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// PUT /availability — 가용/불가 시간 블록 생성·수정(id 있으면 수정). 같은 오너·요일 겹침 시 409.
export class UpsertAvailabilityDto implements UpsertAvailabilityInput {
  @ApiPropertyOptional({ example: 5, description: '수정할 블록 id(없으면 신규 생성)' })
  @IsOptional()
  @IsInt()
  id?: number;

  @ApiProperty({ enum: ['student', 'instructor', 'room'], example: 'instructor', description: '소유 자원 종류' })
  @IsIn(['student', 'instructor', 'room'])
  ownerType!: AvailabilityOwner;

  @ApiProperty({ example: 1, description: '소유 자원 id(ownerType에 따라 students/users/rooms)' })
  @IsInt()
  ownerId!: number;

  @ApiPropertyOptional({ enum: ['available', 'unavailable'], example: 'unavailable', description: '가용/불가(기본 available)' })
  @IsOptional()
  @IsIn(['available', 'unavailable'])
  kind?: AvailabilityKind;

  @ApiProperty({ example: 1, minimum: 0, maximum: 6, description: '요일(0=일 ~ 6=토)' })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @ApiProperty({ example: '12:00', description: '시작(HH:mm)' })
  @Matches(HHMM, { message: 'startTime must be HH:mm' })
  startTime!: string;

  @ApiProperty({ example: '13:00', description: '종료(HH:mm)' })
  @Matches(HHMM, { message: 'endTime must be HH:mm' })
  endTime!: string;

  @ApiPropertyOptional({ example: '2026-06-01', description: '적용 시작일(선택)' })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT.date)
  effectiveFrom?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: '적용 종료일(선택)' })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT.date)
  effectiveTo?: string;
}
