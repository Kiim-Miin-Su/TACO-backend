import type { ClearAttendanceInput } from '@kms545487/contracts';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { TEXT } from '../../../common/validation-limits';

export class ClearAttendanceDto implements ClearAttendanceInput {
  @IsString()
  @MinLength(2)
  @MaxLength(TEXT.memo)
  reason!: string;
}
