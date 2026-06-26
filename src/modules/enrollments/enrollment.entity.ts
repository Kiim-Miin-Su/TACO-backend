import type { Enrollment as EnrollmentContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type { EnrollmentStatus } from '@kms545487/contracts';

export type Enrollment = EnrollmentContract & BaseRow;

export const ENROLLMENTS = 'enrollments';
