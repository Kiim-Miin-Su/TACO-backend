import { IsIn, IsInt, IsOptional, IsString, Matches } from 'class-validator';
import type { CreateCounselRoundInput } from '@kms545487/contracts';

// [참조/처리] POST /counsel/:id/rounds — 상담 회차 추가. roundNo는 서비스가 자동 증가, 부모 폼 nextContactAt 동기화.
const RESULT = ['positive', 'neutral', 'negative', 'no_response', 'registered'] as const;

export class CreateCounselRoundDto implements CreateCounselRoundInput {
  @IsOptional() @IsInt() counselorId?: number;
  @IsOptional() @IsString() summary?: string;
  @IsOptional() @IsString() detail?: string;
  @IsOptional() @IsIn(RESULT as unknown as string[]) result?: CreateCounselRoundInput['result'];
  @IsOptional() @IsString() nextAction?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) nextContactAt?: string;
}
