import type { StudentInterest as StudentInterestContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type StudentInterest = StudentInterestContract & BaseRow;
export const STUDENT_INTERESTS = 'student_interests';
