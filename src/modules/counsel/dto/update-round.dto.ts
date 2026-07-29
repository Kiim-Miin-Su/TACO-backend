import { Type } from 'class-transformer';
import { COUNSEL_RESULTS } from '../counsel.entity'; // [P2 M5]
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import type { UpdateCounselRoundInput } from '@kms545487/contracts';
import { CounselFormSnapshotDto } from './counsel-form-snapshot.dto';
import { CounselInstantField } from '../counsel-instant';

const RESULT = COUNSEL_RESULTS; // [P2 M5]
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class UpdateCounselRoundDto implements Omit<UpdateCounselRoundInput, 'counselorId' | 'formSnapshot'> {
  @IsOptional() @Matches(DATE) scheduledAt?: string | null;
  @IsOptional() @Matches(DATE) completedAt?: string | null;
  @IsOptional() @IsBoolean() isCompleted?: boolean;
  @IsOptional() @IsString() @MaxLength(300) summary?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) detail?: string | null;
  @IsOptional() @IsIn(RESULT as unknown as string[]) result?: UpdateCounselRoundInput['result'];
  @IsOptional() @IsString() @MaxLength(500) nextAction?: string | null;
  @IsOptional() @CounselInstantField({ nullable: true }) nextContactAt?: string | null;
  @IsOptional() @ValidateNested() @Type(() => CounselFormSnapshotDto) formSnapshot?: CounselFormSnapshotDto;
}
