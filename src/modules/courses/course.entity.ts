import type { Course as CourseContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type Course = CourseContract & BaseRow;
export const COURSES = 'courses';
