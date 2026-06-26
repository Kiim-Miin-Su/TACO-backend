import type { Subject as SubjectContract } from '@taco/contracts';
import type { BaseRow } from '../../common/types/base';

export type Subject = SubjectContract & BaseRow;
export const SUBJECTS = 'subjects';
