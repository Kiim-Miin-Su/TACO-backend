import type { ClassSession } from './schedule.entity';
import { resolveSessionParticipantIds } from '@kms545487/contracts';

export type ParticipantEnrollment = {
  studentId: number;
  courseId: number;
  status: string;
};

/** 명시 코호트가 있으면 그것을, 없으면 활성 수강을 세션 학생의 단일 기준으로 사용한다. */
export function studentBelongsToSession(
  session: Pick<ClassSession, 'courseId' | 'studentIds'>,
  studentId: number,
  enrollments: readonly ParticipantEnrollment[],
): boolean {
  return participantIdsForSession(session, buildCohortIndex(enrollments)).includes(Number(studentId));
}

// [EP1 2026-07-16] 대량 판정용 코호트 인덱스 — studentBelongsToSession과 **같은 정책**(활성 수강)을
//  courseId→studentId Set으로 선계산한다. 목록 파생(enrollments N²)처럼 같은 enrollments로
//  여러 세션·여러 행을 판정할 때 행마다 enrollments 전체를 스캔하지 않기 위한 것.
//  정책 변경 시 이 파일의 두 구현을 함께 고칠 것(단일 소스 유지 — 다른 곳에 사본 금지).
export type CohortIndex = Map<number, Set<number>>;

export function buildCohortIndex(enrollments: readonly ParticipantEnrollment[]): CohortIndex {
  const index: CohortIndex = new Map();
  for (const row of enrollments) {
    if (row.status !== 'active') continue;
    if (!index.has(row.courseId)) index.set(row.courseId, new Set());
    index.get(row.courseId)!.add(Number(row.studentId));
  }
  return index;
}

/** 세션의 전체 리포트 대상 학생. 명시 코호트 우선 규칙의 목록형 단일 구현. */
export function participantIdsForSession(
  session: Pick<ClassSession, 'courseId' | 'studentIds'>,
  cohortIndex: CohortIndex,
): number[] {
  return resolveSessionParticipantIds(
    session.studentIds,
    [...(cohortIndex.get(session.courseId) ?? [])],
  );
}

/** studentBelongsToSession의 인덱스 판(동일 의미) — 명시 코호트 우선, 없으면 활성 수강 인덱스. */
export function studentBelongsToSessionIndexed(
  session: Pick<ClassSession, 'courseId' | 'studentIds'>,
  studentId: number,
  cohortIndex: CohortIndex,
): boolean {
  return participantIdsForSession(session, cohortIndex).includes(Number(studentId));
}
