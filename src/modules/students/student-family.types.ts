// [TBO-30G 2026-07-23 대표 지시] 가족(형제·자매) **테이블 조인 단일 진실원** 응답 형상.
//  student_family_relations → students → parent_student_relations → parents → enrollments →
//  counsel_forms를 서버에서 조인해 파생한다(읽기 전용 — 사본 저장 0, 원본 표 무변형).
//  학생 상세·상담 상세·상담 접수가 전부 이 하나의 응답만 소비한다(FE full-list client join 제거).
//  계약(@kms545487/contracts) 승격 전 BE-local 타입 — payouts uncovered와 같은 전례.
import type { Student } from './student.entity';
import type { StudentFamilyRelation } from './student-family-relation.entity';
import type { Parent, ParentStudent } from '../parents/parent.entity';
import type { CounselForm } from '../counsel/counsel.entity';

/** 가족 구성원의 상담 카드 요약 — counsel_forms 조인(민감 본문 referenceNotes는 제외). */
export type StudentFamilyMemberCounsel = Pick<CounselForm, 'id' | 'status' | 'source' | 'createdAt'> & {
  nextContactAt: string | null;
};

export type StudentFamilyMember = {
  relationId: number;
  relationType: StudentFamilyRelation['relationType'];
  relationLabel: string | null;
  /** students 조인 — 이름·학년·학교·상태·연락처(원부 그대로, 사본 아님). */
  student: Student;
  /** parent_student_relations → parents 조인(대표 우선 정렬). */
  guardians: Array<{ parent: Parent; relation: ParentStudent }>;
  /** enrollments 조인 — 활성 수강 수. */
  activeEnrollmentCount: number;
  /** counsel_forms 조인 — 가족 상담 이력(최신순). */
  counselForms: StudentFamilyMemberCounsel[];
  /** 기준 학생과 공유 중인 보호자 parentId(조인 파생 — "가족 공유 보호자" 표시 근거). */
  sharedGuardianParentIds: number[];
};

export type StudentFamilyAggregate = {
  studentId: number;
  members: StudentFamilyMember[];
};
