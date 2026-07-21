import type { StudentAcademicHistory as StudentAcademicHistoryContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type StudentAcademicHistory = StudentAcademicHistoryContract & BaseRow;
export const STUDENT_ACADEMIC_HISTORIES = 'student_academic_histories';
