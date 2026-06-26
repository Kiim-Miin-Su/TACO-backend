import { IsString, MaxLength } from 'class-validator';
import type { CreateSubjectInput } from '@kms545487/contracts';

export class CreateSubjectDto implements CreateSubjectInput {
  @IsString()
  @MaxLength(50)
  code!: string;

  @IsString()
  @MaxLength(50)
  name!: string;
}
