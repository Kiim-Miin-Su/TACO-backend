import { IsIn, IsInt, IsOptional, Min, Max } from 'class-validator';
import type { CreatePaymentInput } from '@kms545487/contracts';
import { PaymentMethod } from '../payment.entity';

export class CreatePaymentDto implements CreatePaymentInput {
  @IsInt()
  studentId!: number;

  @IsOptional()
  @IsInt()
  enrollmentId?: number;

  @IsOptional()
  @IsInt()
  payerParentId?: number;

  @IsInt()
  @Min(0)
  @Max(100_000_000) // [감사 H5] 상한 1억 — 오입력·오버플로우 방지
  amount!: number;

  @IsOptional()
  @IsIn(['card', 'transfer', 'cash', 'point', 'etc'])
  paymentMethod?: PaymentMethod;
}
