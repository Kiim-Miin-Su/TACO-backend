import type { Student as StudentContract } from '@taco/contracts';
import type { BaseRow } from '../../common/types/base';

// enum/유니온은 공유 계약에서 재노출
export type { StudentStatus, ResidenceType } from '@taco/contracts';

// 공유 도메인 형상(@taco/contracts) + 영속 감사필드(BaseRow)
export type Student = StudentContract & BaseRow;

export const STUDENTS = 'students';
