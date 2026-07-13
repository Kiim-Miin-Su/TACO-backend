import type { ClassSession } from './schedule.entity';

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
  if (session.studentIds?.length) return session.studentIds.map(Number).includes(Number(studentId));
  return enrollments.some(
    (row) => row.courseId === session.courseId && row.studentId === studentId && row.status === 'active',
  );
}
