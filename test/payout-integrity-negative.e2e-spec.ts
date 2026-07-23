// [TBO-32 C3 2026-07-22] 정산 무결성 ⑨ 음성 검증 — **위반을 주입해 검출을 증명**한다.
//  db:integrity 스크립트와 같은 순수 함수(checkPayoutIntegrity — 단일 진실원)를 직접 소비:
//  깨끗한 스냅샷 0건 → 각 위반 주입 시 해당 코드만 정확히 발화. "원장 중첩"(이중 출금·이중 보상)
//  주입 케이스 포함(대표 지시). 실제 시드 위반 0은 db:smoke/db:integrity가 실 DB에서 별도 증명.
import { checkPayoutIntegrity, type PayoutIntegritySnapshot } from '../src/modules/payouts/payout-integrity';
import type { InstructorPayoutRow } from '../src/modules/payouts/payout.entity';

const basePayout = (over: Partial<InstructorPayoutRow> = {}): InstructorPayoutRow => ({
  id: 1, instructorId: 1, periodStart: '2026-06-01', periodEnd: '2026-06-30',
  sessionCount: 2, totalMinutes: 210, computedAmount: 140000, amount: 140000, status: 'pending',
  lines: [
    { sessionId: 11, courseId: 10, courseName: 'SAT', sessionDate: '2026-06-08', durationMinutes: 90, hourlyRate: 40000, amount: 60000 },
    { sessionId: 12, courseId: 10, courseName: 'SAT', sessionDate: '2026-06-15', durationMinutes: 120, hourlyRate: 40000, amount: 80000 },
  ],
  createdAt: '2026-06-30T00:00:00Z', updatedAt: '2026-06-30T00:00:00Z',
  ...over,
} as InstructorPayoutRow);

const cleanSnapshot = (): PayoutIntegritySnapshot => ({
  payouts: [basePayout()],
  transactions: [],
  sessions: [
    { id: 11, payoutId: 1, isPaid: false },
    { id: 12, payoutId: 1, isPaid: false },
  ],
});

const codesOf = (s: PayoutIntegritySnapshot) => {
  const r = checkPayoutIntegrity(s);
  return { issues: r.issues.map((i) => i.code), warnings: r.warnings.map((w) => w.code) };
};

describe('Payout integrity ⑨ — 위반 주입 음성 검증 (TBO-32 C3)', () => {
  it('깨끗한 스냅샷: 위반 0 · 경고 0 (기준선)', () => {
    expect(codesOf(cleanSnapshot())).toEqual({ issues: [], warnings: [] });
  });

  it('(a) 명세 합계 ≠ 산정액 → PAYOUT_LINES_SUM_MISMATCH', () => {
    const s = cleanSnapshot();
    s.payouts[0] = basePayout({ computedAmount: 999999, amount: 999999 });
    expect(codesOf(s).issues).toContain('PAYOUT_LINES_SUM_MISMATCH');
  });

  it('(b) 실효액 규칙 위반(amount ≠ adjusted ?? computed) → PAYOUT_AMOUNT_RULE', () => {
    const s = cleanSnapshot();
    s.payouts[0] = basePayout({ amount: 1 }); // computed=140000인데 1
    expect(codesOf(s).issues).toContain('PAYOUT_AMOUNT_RULE');
    const adjusted = cleanSnapshot();
    adjusted.payouts[0] = basePayout({ adjustedAmount: 100000, amount: 100000 });
    expect(codesOf(adjusted).issues).toEqual([]); // 조정 반영은 정상
  });

  it('(c) 지급 원장: 출금 0건·**이중 출금(원장 중첩)** 모두 PAYOUT_PAID_LEDGER', () => {
    const missing = cleanSnapshot();
    missing.payouts[0] = basePayout({ status: 'paid', paidAt: '2026-07-01T00:00:00Z' });
    expect(codesOf(missing).issues).toContain('PAYOUT_PAID_LEDGER'); // 출금 0건(유령 지급)

    const doubled = cleanSnapshot();
    doubled.payouts[0] = basePayout({ status: 'paid', paidAt: '2026-07-01T00:00:00Z' });
    doubled.transactions = [
      { id: 1, direction: 'out', category: 'instructor_payout', payoutId: 1 },
      { id: 2, direction: 'out', category: 'instructor_payout', payoutId: 1 }, // 이중 지급 기록 주입
    ];
    expect(codesOf(doubled).issues).toContain('PAYOUT_PAID_LEDGER');
  });

  it('(d) 회수 원장: 보상 입금 0건·**이중 보상(원장 중첩)** 모두 PAYOUT_REVERSAL_LEDGER', () => {
    const reversedBase = { status: 'rejected' as const, reversedAt: '2026-07-02T00:00:00Z', rejectedReason: '회수', reversedReason: '회수' };
    const missing = cleanSnapshot();
    missing.payouts[0] = basePayout(reversedBase);
    missing.transactions = [{ id: 1, direction: 'out', category: 'instructor_payout', payoutId: 1 }];
    missing.sessions = missing.sessions.map((x) => ({ ...x, payoutId: null })); // 회수=세션 해제 상태
    expect(codesOf(missing).issues).toContain('PAYOUT_REVERSAL_LEDGER'); // 보상 0건

    const doubled = cleanSnapshot();
    doubled.payouts[0] = basePayout(reversedBase);
    doubled.transactions = [
      { id: 1, direction: 'out', category: 'instructor_payout', payoutId: 1 },
      { id: 2, direction: 'in', category: 'payout_reversal', payoutId: 1 },
      { id: 3, direction: 'in', category: 'payout_reversal', payoutId: 1 }, // 이중 보상 주입
    ];
    doubled.sessions = doubled.sessions.map((x) => ({ ...x, payoutId: null }));
    expect(codesOf(doubled).issues).toContain('PAYOUT_REVERSAL_LEDGER');
  });

  it('(c보강) 미지급 상태에 원장 참조 → PAYOUT_LEDGER_UNEXPECTED', () => {
    const s = cleanSnapshot();
    s.transactions = [{ id: 1, direction: 'out', category: 'instructor_payout', payoutId: 1 }];
    expect(codesOf(s).issues).toContain('PAYOUT_LEDGER_UNEXPECTED');
  });

  it('(e) 세션↔정산서 양방향: 역참조 훼손·고아 세션 검출', () => {
    const broken = cleanSnapshot();
    broken.sessions[0] = { id: 11, payoutId: null, isPaid: false }; // lines에 있는데 세션은 해제됨
    expect(codesOf(broken).issues).toContain('PAYOUT_SESSION_LINK');

    const orphan = cleanSnapshot();
    orphan.sessions.push({ id: 99, payoutId: 777, isPaid: false }); // 존재하지 않는 정산서 참조
    expect(codesOf(orphan).issues).toContain('SESSION_PAYOUT_ORPHAN');

    const notInLines = cleanSnapshot();
    notInLines.sessions.push({ id: 13, payoutId: 1, isPaid: false }); // 정산서는 있으나 lines에 없음
    expect(codesOf(notInLines).issues).toContain('SESSION_PAYOUT_ORPHAN');
  });

  it('(f) 같은 강사 활성 기간 중첩 → 경고 PAYOUT_PERIOD_OVERLAP (반려는 제외)', () => {
    const s = cleanSnapshot();
    const second = basePayout({ id: 2, periodStart: '2026-06-15', periodEnd: '2026-07-14', lines: [], sessionCount: 0, totalMinutes: 0, computedAmount: 0, amount: 0 });
    s.payouts.push(second);
    const r = codesOf(s);
    expect(r.warnings).toContain('PAYOUT_PERIOD_OVERLAP');
    expect(r.issues).toEqual([]); // 경고이지 하드 위반이 아니다(늦은 보고서 승인 등 정당 사례)

    // 반려(회수)된 정산과의 중첩은 경고 아님 — 재산정의 정상 경로
    const rejectedOverlap = cleanSnapshot();
    rejectedOverlap.payouts.push(basePayout({ id: 2, status: 'rejected', lines: [], sessionCount: 0, totalMinutes: 0, computedAmount: 0, amount: 0 }));
    expect(codesOf(rejectedOverlap).warnings).toEqual([]);
  });
});
