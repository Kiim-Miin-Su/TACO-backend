import {
  accountingImpactOf,
  classifySessionForPayout,
  countsForTeachingHours,
  isPayoutLocked,
  type SessionPricingInput,
} from '../src/modules/schedule/session-accounting.policy';
import { sessionAccountingLockKeys } from '../src/database/calendar-unit-of-work.service';

// [TBO-79 B1] accountingProjectionOf가 payout 분류(classifySessionForPayout)를 소비하도록 수렴하면서
//  입력이 `approvedReport: boolean`에서 SessionPricingInput으로 바뀌었다. 아래 헬퍼는 기존 진리표의
//  의도(리포트 승인 여부만 변주)를 보존하면서 새 정책을 그대로 통과시킨다.
const RATE = 50000;
const pricing = (
  approvedReport: boolean,
  over: Partial<SessionPricingInput> = {},
): SessionPricingInput => ({
  participantIds: [1],
  reportOf: () => ({ approvalStatus: approvedReport ? 'approved' : 'draft' }),
  attendanceOf: () => 'present',
  hourlyRate: RATE,
  ...over,
});

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
      { before: pricing(true), after: pricing(true) },
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
    // [TBO-79 B1] 지각은 시수는 유지하되 자동 정산에서 빠진다 — 종전엔 delta 0으로 계산돼 ack를 우회했다.
    ['held60 present -> late(승인 리포트)', { status: 'held', durationMinutes: 60, instructorAttendance: 'present' }, { status: 'held', durationMinutes: 60, instructorAttendance: 'late' }, true, true, 0, -60, -50000],
  ] as const)('%s', (_label, before, after, beforeApproved, afterApproved, dTeach, dEligible, dAmount) => {
    const impact = accountingImpactOf(before as never, after as never, {
      before: pricing(beforeApproved),
      after: pricing(afterApproved),
    });
    expect(impact.delta.teachingMinutes).toBe(dTeach);
    expect(impact.delta.payoutEligibleMinutes).toBe(dEligible);
    expect(impact.delta.computedAmount).toBe(dAmount);
    expect(impact.changed).toBe(dTeach !== 0 || dEligible !== 0 || dAmount !== 0);
  });

  // [TBO-79 B1] 미리보기가 정산서 라인과 같은 값을 보고하는지 — 책정가·출결 미기록 축.
  it('책정가(override)가 있으면 미리보기 금액도 책정가를 따른다', () => {
    const impact = accountingImpactOf(
      { status: 'held', durationMinutes: 60, instructorPayAmount: 123000 },
      { status: 'held', durationMinutes: 90, instructorPayAmount: 123000 },
      { before: pricing(true), after: pricing(true) },
    );
    expect(impact.before.computedAmount).toBe(123000); // 시급×시간(50,000)이 아니다
    expect(impact.after.computedAmount).toBe(123000);
    expect(impact.delta.teachingMinutes).toBe(30);
  });

  it('학생 출결 미기록은 자동 정산 대상이 아니다(책정 전 0)', () => {
    const impact = accountingImpactOf(
      { status: 'held', durationMinutes: 60 },
      { status: 'held', durationMinutes: 60 },
      { before: pricing(true), after: pricing(true, { attendanceOf: () => undefined }) },
    );
    expect(impact.before.computedAmount).toBe(50000);
    expect(impact.after.computedAmount).toBe(0);
    expect(impact.after.teachingMinutes).toBe(60); // 시수는 유지 — 가르친 시간이다
    expect(impact.changed).toBe(true);
  });

  // 분류 함수의 소유가 schedule으로 옮겨왔으므로 진리표도 여기서 함께 고정한다(payouts는 재export).
  it.each([
    ['auto', { status: 'held', durationMinutes: 60 }, pricing(true), 'auto', 50000],
    ['late -> manual', { status: 'held', durationMinutes: 60, instructorAttendance: 'late' }, pricing(true), 'manual', null],
    ['late + 책정가 -> manual이지만 금액 있음', { status: 'held', durationMinutes: 60, instructorAttendance: 'late', instructorPayAmount: 70000 }, pricing(true), 'manual', 70000],
    ['리포트 미승인 -> manual', { status: 'held', durationMinutes: 60 }, pricing(false), 'manual', null],
    ['출결 미기록 -> manual', { status: 'held', durationMinutes: 60 }, pricing(true, { attendanceOf: () => undefined }), 'manual', null],
    ['roster 없음 -> manual', { status: 'held', durationMinutes: 60 }, pricing(true, { participantIds: [] }), 'manual', null],
    ['시급 미설정 -> manual', { status: 'held', durationMinutes: 60 }, pricing(true, { hourlyRate: 0 }), 'manual', null],
    ['scheduled -> excluded', { status: 'scheduled', durationMinutes: 60 }, pricing(true), 'excluded', null],
    ['absent -> excluded', { status: 'held', durationMinutes: 60, instructorAttendance: 'absent' }, pricing(true), 'excluded', null],
    ['정산 연결 -> excluded', { status: 'held', durationMinutes: 60, payoutId: 7 }, pricing(true), 'excluded', null],
  ] as const)('가격 분류: %s', (_label, session, input, kind, effectiveAmount) => {
    const classification = classifySessionForPayout(session as never, input);
    expect(classification.kind).toBe(kind);
    expect(classification.effectiveAmount).toBe(effectiveAmount);
  });

  it('payout-linked는 미리보기+acknowledge로도 우회 불가 판정의 근거(isPayoutLocked) — reversal 요구 유지', () => {
    expect(isPayoutLocked({ status: 'held', durationMinutes: 60, payoutId: 77 })).toBe(true);
    expect(isPayoutLocked({ status: 'held', durationMinutes: 60, payoutId: null })).toBe(false);
    expect(isPayoutLocked({ status: 'held', durationMinutes: 60 })).toBe(false);
  });

  it('회계 잠금 키는 session → report 의미 순서로 중앙 생성하고 중복 제거는 UoW에 위임한다', () => {
    expect(sessionAccountingLockKeys({
      sessionIds: [12, undefined, 11],
      reportIds: [32, undefined, 31],
    })).toEqual([
      { kind: 'session', id: 12 },
      { kind: 'session', id: 11 },
      { kind: 'report', id: 32 },
      { kind: 'report', id: 31 },
    ]);
  });
});
