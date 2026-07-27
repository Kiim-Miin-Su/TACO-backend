import type { Student } from '../src/modules/students/student.entity';
import type { StudentAcademicHistory } from '../src/modules/students/student-academic-history.entity';
import {
  currentAcademicHistory,
  projectStudentAcademicProfile,
} from '../src/modules/students/student-academic-projection';

const student = { id: 7, name: '학생', status: 'enrolled' } as Student;
const history = (
  id: number,
  grade: number,
  schoolName: string,
  startedOn: string,
  endedOn: string | null,
): StudentAcademicHistory => ({
  id,
  studentId: student.id,
  grade,
  schoolName,
  startedOn,
  endedOn,
  changedBy: 3,
  changedAt: '2026-07-27T00:00:00.000Z',
  createdAt: '2026-07-27T00:00:00.000Z',
  updatedAt: '2026-07-27T00:00:00.000Z',
});

describe('student academic history read projection', () => {
  const rows = [
    history(1, 4, '과거학교', '2025-01-01', '2025-12-31'),
    history(2, 5, '현재학교', '2026-01-01', null),
    history(3, 6, '미래학교', '2027-01-01', null),
  ];

  it('selects only the current interval and projects grade and school from the history SSOT', () => {
    expect(currentAcademicHistory(rows, '2026-07-27')).toMatchObject({ id: 2 });
    expect(projectStudentAcademicProfile(student, rows, '2026-07-27')).toMatchObject({
      id: student.id,
      grade: 5,
      schoolName: '현재학교',
    });
  });

  it('clears a stale denormalized value when there is no current interval', () => {
    const stale = { ...student, grade: 13, schoolName: '사본학교' };
    expect(projectStudentAcademicProfile(stale, rows, '2024-07-27')).toMatchObject({
      grade: undefined,
      schoolName: undefined,
    });
  });

  it('uses the latest starting interval deterministically if legacy rows overlap', () => {
    const overlapping = [...rows, history(4, 7, '최신학교', '2026-06-01', null)];
    expect(currentAcademicHistory(overlapping, '2026-07-27')).toMatchObject({ id: 4 });
  });
});
