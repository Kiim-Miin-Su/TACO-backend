import type { Payment as PaymentContract } from '@taco/contracts';
import type { BaseRow } from '../../common/types/base';

export type { PaymentStatus, PaymentMethod } from '@taco/contracts';

export type Payment = PaymentContract & BaseRow;

export const PAYMENTS = 'payments';
