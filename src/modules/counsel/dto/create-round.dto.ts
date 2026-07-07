import { IsIn, IsInt, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { CreateCounselRoundInput } from '@kms545487/contracts';

// [참조/처리] POST /counsel/:id/rounds — 상담 회차 추가. roundNo는 서비스가 자동 증가, 부모 폼 nextContactAt 동기화.
const RESULT = ['positive', 'neutral', 'negative', 'no_response', 'registered'] as const;
// [보안 2026-07-07] 회차 자유 텍스트 상한(무제한 방지).
const ROUND_TEXT = { summary: 300, detail: 2000, nextAction: 500 } as const;

export class CreateCounselRoundDto implements CreateCounselRoundInput {
  @IsOptional() @IsInt() counselorId?: number;
  @IsOptional() @IsString() @MaxLength(ROUND_TEXT.summary) summary?: string;
  @IsOptional() @IsString() @MaxLength(ROUND_TEXT.detail) detail?: string;
  @IsOptional() @IsIn(RESULT as unknown as string[]) result?: CreateCounselRoundInput['result'];
  @IsOptional() @IsString() @MaxLength(ROUND_TEXT.nextAction) nextAction?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) nextContactAt?: string;
}
