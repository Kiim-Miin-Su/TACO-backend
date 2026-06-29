import type { ClassSession as ClassSessionContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type ClassSession = ClassSessionContract & BaseRow;
export const SESSIONS = 'class_sessions';
