import type { Enrollment as EnrollmentContract } from '@kms545487/contracts';
import type { EnrollmentStatus } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type { EnrollmentStatus } from '@kms545487/contracts';

export type Enrollment = EnrollmentContract & BaseRow;

export const ENROLLMENT_STATUSES =
  ['active', 'paused', 'completed', 'canceled'] as const satisfies readonly EnrollmentStatus[];

export const ENROLLMENTS = 'enrollments';
