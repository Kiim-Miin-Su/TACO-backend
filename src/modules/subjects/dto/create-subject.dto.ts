import { IsString, MaxLength } from 'class-validator';
import type { CreateSubjectInput } from '@taco/contracts';

export class CreateSubjectDto implements CreateSubjectInput {
  @IsString()
  @MaxLength(50)
  code!: string;

  @IsString()
  @MaxLength(50)
  name!: string;
}
