import type { Parent as ParentContract, ParentStudent as ParentStudentContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// [참조/처리] 보호자(parents) + 학생↔보호자 관계(parent_student_relations, M:N).
//  - ParentStudent.parentId → parents.id, studentId → students.id (서비스에서 FK 검증).
//  - 무결성: (parentId, studentId) 유니크 + 학생당 isPrimary=true 최대 1명(대표 보호자) 불변.
export type Parent = ParentContract & BaseRow;
export type ParentStudent = ParentStudentContract & BaseRow;
export const PARENTS = 'parents';
export const PARENT_STUDENTS = 'parent_student_relations';
