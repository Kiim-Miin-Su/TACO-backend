import { accountingImpactOf, countsForTeachingHours } from '../src/modules/schedule/session-accounting.policy';

describe('session accounting policy', () => {
  it.each(['scheduled', 'canceled', 'no_show', 'makeup'] as const)('%s는 강사 출결과 무관하게 시수 제외', (status) => {
    expect(countsForTeachingHours({ status, durationMinutes: 60, instructorAttendance: 'present' })).toBe(false);
  });

  it.each([undefined, null, 'present', 'late', 'makeup'] as const)('held + %s는 시수 인정', (instructorAttendance) => {
    expect(countsForTeachingHours({ status: 'held', durationMinutes: 60, instructorAttendance })).toBe(true);
  });

  it('held + absent는 제외되고 expected delta를 계산한다', () => {
    const impact = accountingImpactOf(
      { status: 'held', durationMinutes: 90, instructorAttendance: 'present' },
      { status: 'held', durationMinutes: 90, instructorAttendance: 'absent' },
      { beforeApprovedReport: true, afterApprovedReport: true, beforeHourlyRate: 50000, afterHourlyRate: 50000 },
    );
    expect(impact).toMatchObject({
      changed: true,
      before: { teachingMinutes: 90, computedAmount: 75000 },
      after: { teachingMinutes: 0, computedAmount: 0 },
      delta: { teachingMinutes: -90, computedAmount: -75000 },
    });
  });
});
