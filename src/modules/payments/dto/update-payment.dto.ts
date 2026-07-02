import { IsIn, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import type { UpdatePaymentInput } from '@kms545487/contracts';
import { PaymentMethod } from '../payment.entity';

// [참조/처리] PATCH /payments/:id — 청구 금액·수단·기한·메모 수정(수납 완료여도 관리자 정정 가능).
export class UpdatePaymentDto implements UpdatePaymentInput {
  @IsOptional() @IsInt() @Min(0) amount?: number;
  @IsOptional() @IsIn(['card', 'transfer', 'cash', 'point', 'etc']) paymentMethod?: PaymentMethod;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueAt?: string;
  @IsOptional() @IsString() memo?: string;
}
