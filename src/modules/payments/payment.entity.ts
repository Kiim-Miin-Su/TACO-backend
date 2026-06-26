import type { Payment as PaymentContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type { PaymentStatus, PaymentMethod } from '@kms545487/contracts';

export type Payment = PaymentContract & BaseRow;

export const PAYMENTS = 'payments';
