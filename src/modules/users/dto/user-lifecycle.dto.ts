import { IsString, MaxLength, MinLength } from 'class-validator';
import { TEXT } from '../../../common/validation-limits';

export class UserLifecycleDto {
  @IsString()
  @MinLength(5)
  @MaxLength(TEXT.long)
  reason!: string;
}
