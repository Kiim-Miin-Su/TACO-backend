import { assertExpectedAfter } from '../src/common/expected-after.util';
import { checkAccountingIntegrity, type AccountingIntegritySnapshot } from '../src/modules/payouts/accounting-integrity';

const valid = (): AccountingIntegritySnapshot => ({
  sessions: [{ id: 10, courseId: 1, instructorId: 7, studentIds: [3], payoutId: 20, instructorPayAmount: 50000 }],
  attendance: [{ id: 1, sessionId: 10, studentId: 3 }],
  reports: [{ id: 2, sessionId: 10, studentId: 3, instructorId: 7 }],
  payouts: [{ id: 20, status: 'paid', sessionCount: 1, totalMinutes: 60, computedAmount: 50000, amount: 50000, lines: [{ sessionId: 10, durationMinutes: 60, amount: 50000 }] }],
  transactions: [{ id: 30, direction: 'out', category: 'instructor_payout', amount: 50000, payoutId: 20 }],
  students: [{ id: 3 }],
  enrollments: [],
});

describe('accounting relational integrity', () => {
  it('valid snapshot has expected === after and no issues', () => {
    const after = checkAccountingIntegrity(valid());
    assertExpectedAfter('valid accounting snapshot', [], after);
  });

  it.each([
    ['ATTENDANCE_ORPHAN_SESSION', (s: AccountingIntegritySnapshot) => { (s.attendance[0] as { sessionId: number }).sessionId = 999; }],
    ['REPORT_INSTRUCTOR_MISMATCH', (s: AccountingIntegritySnapshot) => { (s.reports[0] as { instructorId: number }).instructorId = 8; }],
    ['PAYOUT_TOTAL_MISMATCH', (s: AccountingIntegritySnapshot) => { (s.payouts[0] as { totalMinutes: number }).totalMinutes = 59; }],
    ['PAYOUT_BACKREF_MISMATCH', (s: AccountingIntegritySnapshot) => { (s.sessions[0] as { payoutId: number }).payoutId = 21; }],
    ['PAYOUT_TX_MISMATCH', (s: AccountingIntegritySnapshot) => { (s.transactions[0] as { amount: number }).amount = 1; }],
  ])('detects %s', (code, mutate) => {
    const snapshot = structuredClone(valid());
    mutate(snapshot);
    expect(checkAccountingIntegrity(snapshot).map((row) => row.code)).toContain(code);
  });
});
