import type { Student } from './student.entity';
import type { StudentAcademicHistory } from './student-academic-history.entity';

export function currentAcademicHistory(
  histories: readonly StudentAcademicHistory[],
  today: string,
): StudentAcademicHistory | undefined {
  return histories
    .filter((row) => row.startedOn <= today && (row.endedOn == null || row.endedOn >= today))
    .sort((a, b) => b.startedOn.localeCompare(a.startedOn) || b.id - a.id)[0];
}

export function projectStudentAcademicProfile<T extends Student>(
  student: T,
  histories: readonly StudentAcademicHistory[],
  today: string,
): T {
  const current = currentAcademicHistory(histories, today);
  return {
    ...student,
    grade: current?.grade,
    schoolName: current?.schoolName,
  };
}
