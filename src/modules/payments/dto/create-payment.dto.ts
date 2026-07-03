import { IsIn, IsInt, IsOptional, Matches, Min, Max } from 'class-validator';
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

  // [보안 2026-07-03] DTO 누락 필드 복원 — whitelist가 조용히 버려 미수 기한이 저장 안 되던 실제 갭
  //  (forbidNonWhitelisted 도입으로 드러남). 계약 CreatePaymentInput.dueAt과 정합.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dueAt?: string;
}
