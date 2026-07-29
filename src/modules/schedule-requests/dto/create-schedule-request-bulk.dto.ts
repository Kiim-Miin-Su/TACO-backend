import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type {
  CreateScheduleRequestBulkInput,
  ScheduleRequest,
  ScheduleRequestBulkConflict,
  ScheduleRequestBulkResult,
} from '@kms545487/contracts';
import { CreateScheduleRequestDto } from './create-schedule-request.dto';

export class CreateScheduleRequestBulkDto implements CreateScheduleRequestBulkInput {
  @ApiProperty({
    format: 'uuid',
    example: '2f84826a-33c4-4aa5-9a12-30d9994ee6e3',
    description: '한 제출 시도에 한 번 발급하고 network retry에 재사용하는 UUID v4',
  })
  @IsUUID(4)
  idempotencyKey!: string;

  @ApiProperty({ type: () => [CreateScheduleRequestDto], minItems: 2, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateScheduleRequestDto)
  requests!: CreateScheduleRequestDto[];
}

class ScheduleRequestBulkConflictDto implements ScheduleRequestBulkConflict {
  @ApiProperty({ minimum: 0 })
  requestIndex!: number;

  @ApiProperty({ type: Object })
  conflict!: ScheduleRequestBulkConflict['conflict'];
}

export class ScheduleRequestBulkResultDto implements ScheduleRequestBulkResult {
  @ApiProperty({ type: Object, isArray: true })
  rows!: ScheduleRequest[];

  @ApiProperty({ type: () => [ScheduleRequestBulkConflictDto] })
  conflicts!: ScheduleRequestBulkConflict[];

  @ApiProperty()
  replayed!: boolean;
}
