import { IsIn, IsInt, IsOptional, IsString, Matches, Min, Max, MaxLength } from 'class-validator';
import type { UpdatePaymentInput } from '@kms545487/contracts';
import { PaymentMethod } from '../payment.entity';
import { TEXT, MAX_AMOUNT } from '../../../common/validation-limits'; // [보안] 상한 단일 소스

// [참조/처리] PATCH /payments/:id — 청구 금액·수단·기한·메모 수정(수납 완료여도 관리자 정정 가능).
export class UpdatePaymentDto implements UpdatePaymentInput {
  @IsOptional() @IsInt() @Min(0) @Max(MAX_AMOUNT) amount?: number;
  @IsOptional() @IsIn(['card', 'transfer', 'cash', 'point', 'etc']) paymentMethod?: PaymentMethod;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueAt?: string;
  @IsOptional() @IsString() @MaxLength(TEXT.memo) memo?: string;
}
