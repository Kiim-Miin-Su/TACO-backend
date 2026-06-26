import type { Course as CourseContract } from '@taco/contracts';
import type { BaseRow } from '../../common/types/base';

export type Course = CourseContract & BaseRow;
export const COURSES = 'courses';
