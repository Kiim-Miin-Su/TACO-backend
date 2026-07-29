// [TBO-30G 2026-07-23 대표 지시] 가족(형제·자매) **테이블 조인 단일 진실원** 응답 형상.
//  student_family_relations → students → parent_student_relations → parents → enrollments →
//  counsel_forms를 서버에서 조인해 파생한다(읽기 전용 — 사본 저장 0, 원본 표 무변형).
//  학생 상세·상담 상세·상담 접수가 전부 이 하나의 응답만 소비한다(FE full-list client join 제거).
//  계약(@kms545487/contracts) 승격 전 BE-local 타입 — payouts uncovered와 같은 전례.
export type {
  StudentFamilyAggregate,
  StudentFamilyMember,
  StudentFamilyMemberCounsel,
} from '@kms545487/contracts';
