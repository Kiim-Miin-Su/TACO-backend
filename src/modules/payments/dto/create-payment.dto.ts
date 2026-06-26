import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import type { CreatePaymentInput } from '@taco/contracts';
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
  amount!: number;

  @IsOptional()
  @IsIn(['card', 'transfer', 'cash', 'point', 'etc'])
  paymentMethod?: PaymentMethod;
}
