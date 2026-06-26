import type { Enrollment as EnrollmentContract } from '@taco/contracts';
import type { BaseRow } from '../../common/types/base';

export type { EnrollmentStatus } from '@taco/contracts';

export type Enrollment = EnrollmentContract & BaseRow;

export const ENROLLMENTS = 'enrollments';
