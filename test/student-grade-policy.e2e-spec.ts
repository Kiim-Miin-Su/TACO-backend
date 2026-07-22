import { ageOnDate, studentGradeBirthDateError, studentGradeLabel } from '../src/modules/students/student-grade.policy';

describe('student grade and birth-date policy', () => {
  it('computes full age at the birthday boundary', () => {
    expect(ageOnDate('2020-07-22', '2026-07-21')).toBe(5);
    expect(ageOnDate('2020-07-21', '2026-07-21')).toBe(6);
  });

  it('allows Kinder only from age 3 through 7', () => {
    expect(studentGradeBirthDateError(0, '2023-07-21', '2026-07-21')).toBeNull();
    expect(studentGradeBirthDateError(0, '2019-07-21', '2026-07-21')).toBeNull();
    expect(studentGradeBirthDateError(0, '2024-07-21', '2026-07-21')).toContain('3~7세');
    expect(studentGradeBirthDateError(0, '2018-07-21', '2026-07-21')).toContain('3~7세');
    expect(studentGradeBirthDateError(1, '2024-07-21', '2026-07-21')).toBeNull();
  });

  it('formats Kinder and grade projections consistently', () => {
    expect(studentGradeLabel(0)).toBe('Kinder');
    expect(studentGradeLabel(1)).toBe('G1');
    expect(studentGradeLabel(13)).toBe('G13');
    expect(studentGradeLabel(null)).toBeUndefined();
  });
});
