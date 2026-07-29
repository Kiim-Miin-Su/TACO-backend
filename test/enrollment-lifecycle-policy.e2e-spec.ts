import { enrollmentIncludesSessionDate } from '../src/modules/enrollments/enrollment-lifecycle.policy';

describe('enrollmentIncludesSessionDate', () => {
  it('등록 전 과거 수업은 완료 회차에 포함하지 않는다', () => {
    const enrollment = {
      enrolledAt: '2026-07-29',
      startDate: null,
      endDate: null,
    };
    expect(enrollmentIncludesSessionDate(enrollment, '2026-07-28')).toBe(false);
    expect(enrollmentIncludesSessionDate(enrollment, '2026-07-29')).toBe(true);
  });

  it('명시 시작일·종료일 경계를 모두 포함한다', () => {
    const enrollment = {
      enrolledAt: '2026-07-01',
      startDate: '2026-07-10',
      endDate: '2026-07-20',
    };
    expect(enrollmentIncludesSessionDate(enrollment, '2026-07-09')).toBe(false);
    expect(enrollmentIncludesSessionDate(enrollment, '2026-07-10')).toBe(true);
    expect(enrollmentIncludesSessionDate(enrollment, '2026-07-20')).toBe(true);
    expect(enrollmentIncludesSessionDate(enrollment, '2026-07-21')).toBe(false);
  });
});
