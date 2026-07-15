import { accountingImpactOf, countsForTeachingHours, isPayoutLocked } from '../src/modules/schedule/session-accounting.policy';

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

  // [TBO-29C C4] expected/after 고정 fixture 표 — 29C §6 우선 테스트 명세의 회계 행을 코드로 고정.
  //  형식: (before 상태, after 상태, 승인 리포트 유무) -> (teaching delta, payout-eligible delta, 금액 delta @50,000원).
  const RATE = { beforeHourlyRate: 50000, afterHourlyRate: 50000 };
  it.each([
    // held 90분 -> absent: 시수·정산 미리보기 -90분(-75,000)
    ['held90 -> absent(승인 리포트)', { status: 'held', durationMinutes: 90, instructorAttendance: 'present' }, { status: 'held', durationMinutes: 90, instructorAttendance: 'absent' }, true, true, -90, -90, -75000],
    // held -> canceled: 취소는 시수 제외
    ['held90 -> canceled', { status: 'held', durationMinutes: 90 }, { status: 'canceled', durationMinutes: 90 }, true, true, -90, -90, -75000],
    // scheduled -> held: 시수 +
    ['scheduled -> held120', { status: 'scheduled', durationMinutes: 120 }, { status: 'held', durationMinutes: 120 }, true, true, 120, 120, 100000],
    // makeup(보강 회차)은 상태가 held가 아니므로 시수 제외 — held로 바뀌어야 인정
    ['makeup -> held90', { status: 'makeup', durationMinutes: 90 }, { status: 'held', durationMinutes: 90 }, true, true, 90, 90, 75000],
    // 승인 리포트가 없으면 payout eligible 0 — teaching delta만 발생
    ['held60 시수만(리포트 미승인)', { status: 'scheduled', durationMinutes: 60 }, { status: 'held', durationMinutes: 60 }, false, false, 60, 0, 0],
    // 리포트 승인 자체가 정산 대상 편입 — 세션 필드 무변화여도 eligible/금액 delta 발생
    ['리포트 승인(세션 불변)', { status: 'held', durationMinutes: 60 }, { status: 'held', durationMinutes: 60 }, false, true, 0, 60, 50000],
  ] as const)('%s', (_label, before, after, beforeApproved, afterApproved, dTeach, dEligible, dAmount) => {
    const impact = accountingImpactOf(before as never, after as never, {
      beforeApprovedReport: beforeApproved, afterApprovedReport: afterApproved, ...RATE,
    });
    expect(impact.delta.teachingMinutes).toBe(dTeach);
    expect(impact.delta.payoutEligibleMinutes).toBe(dEligible);
    expect(impact.delta.computedAmount).toBe(dAmount);
    expect(impact.changed).toBe(dTeach !== 0 || dEligible !== 0 || dAmount !== 0);
  });

  it('payout-linked는 미리보기+acknowledge로도 우회 불가 판정의 근거(isPayoutLocked) — reversal 요구 유지', () => {
    expect(isPayoutLocked({ status: 'held', durationMinutes: 60, payoutId: 77 })).toBe(true);
    expect(isPayoutLocked({ status: 'held', durationMinutes: 60, payoutId: null })).toBe(false);
    expect(isPayoutLocked({ status: 'held', durationMinutes: 60 })).toBe(false);
  });
});
