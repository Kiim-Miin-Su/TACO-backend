import { Type } from 'class-transformer';
import { COUNSEL_RESULTS } from '../counsel.entity'; // [P2 M5]
import { IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import type { CreateCounselRoundInput } from '@kms545487/contracts';
import { CounselFormSnapshotDto } from './counsel-form-snapshot.dto';
import { CounselInstantField } from '../counsel-instant';

// [참조/처리] POST /counsel/:id/rounds — 상담 회차 추가. roundNo는 서비스가 자동 증가, 부모 폼 nextContactAt 동기화.
const RESULT = COUNSEL_RESULTS; // [P2 M5]
// [보안 2026-07-07] 회차 자유 텍스트 상한(무제한 방지).
const ROUND_TEXT = { summary: 300, detail: 2000, nextAction: 500 } as const;

export class CreateCounselRoundDto implements Omit<CreateCounselRoundInput, 'counselorId' | 'formSnapshot'> {
  @IsOptional() @IsString() @MaxLength(ROUND_TEXT.summary) summary?: string;
  @IsOptional() @IsString() @MaxLength(ROUND_TEXT.detail) detail?: string;
  @IsOptional() @IsIn(RESULT as unknown as string[]) result?: CreateCounselRoundInput['result'];
  @IsOptional() @IsString() @MaxLength(ROUND_TEXT.nextAction) nextAction?: string;
  @IsOptional() @CounselInstantField() nextContactAt?: string;
  @IsOptional() @ValidateNested() @Type(() => CounselFormSnapshotDto) formSnapshot?: CounselFormSnapshotDto;
}
