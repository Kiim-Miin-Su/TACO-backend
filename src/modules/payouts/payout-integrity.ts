// [TBO-32 C3 2026-07-22 D3] 정산 무결성 검사 ⑨ — **순수 함수 단일 진실원**.
//  db:integrity 스크립트(실 DB 실측)와 음성 검증 e2e(위반 주입→검출)가 같은 함수를 소비한다
//  (accounting-integrity.ts의 확립 패턴 승계 — 검사 로직이 두 곳에서 갈라지지 않게).
//  검사군: (a) 명세 합계=산정액 (b) 실효액 규칙 (c) 지급↔원장 출금 정확 1건
//  (d) 회수↔보상 입금 정확 1건(+출금 쌍 잔존 — 원장 append-only) (e) 세션↔정산서 양방향 링크
//  (f) 같은 강사 활성 정산 기간 중첩 — **경고**(같은 기간 추가 산정은 늦은 보고서 승인 등
//  정당 사례가 있어 하드 위반이 아님 — 세션 이중 계상 자체는 (e)와 CAS가 막는다). 전부 읽기 전용.
import type { InstructorPayoutRow } from './payout.entity';

export type PayoutIntegrityIssue = { code: string; entity: string; entityId?: number; message: string };

export type PayoutIntegritySnapshot = {
  payouts: InstructorPayoutRow[];
  transactions: Array<{ id: number; direction: string; category: string; payoutId?: number | null }>;
  sessions: Array<{ id: number; payoutId?: number | null; isPaid?: boolean }>;
};

const isActivePayout = (p: InstructorPayoutRow): boolean => p.status !== 'rejected';

export function checkPayoutIntegrity(s: PayoutIntegritySnapshot): { issues: PayoutIntegrityIssue[]; warnings: PayoutIntegrityIssue[] } {
  const issues: PayoutIntegrityIssue[] = [];
  const warnings: PayoutIntegrityIssue[] = [];
  const push = (code: string, entityId: number | undefined, message: string) =>
    issues.push({ code, entity: 'instructor_payouts', entityId, message });

  const sessionById = new Map(s.sessions.map((row) => [row.id, row]));
  const txByPayout = new Map<number, Array<{ direction: string; category: string }>>();
  for (const tx of s.transactions) {
    if (tx.payoutId == null) continue;
    const list = txByPayout.get(Number(tx.payoutId)) ?? [];
    list.push(tx);
    txByPayout.set(Number(tx.payoutId), list);
  }

  for (const p of s.payouts) {
    const lines = p.lines ?? [];

    // (a) 명세 합계 = 자동 산정액 — 스냅샷 lines가 진실원이므로 어긋나면 산정 이후 조작/드리프트.
    const linesSum = lines.reduce((acc, l) => acc + l.amount, 0);
    if (linesSum !== p.computedAmount)
      push('PAYOUT_LINES_SUM_MISMATCH', p.id, `sum(lines)=${linesSum} ≠ computedAmount=${p.computedAmount}`);

    // (b) 실효 지급액 규칙 — amount = adjustedAmount ?? computedAmount.
    const expectedAmount = p.adjustedAmount ?? p.computedAmount;
    if (p.amount !== expectedAmount)
      push('PAYOUT_AMOUNT_RULE', p.id, `amount=${p.amount} ≠ (adjusted ?? computed)=${expectedAmount}`);

    // (c)(d) 원장 대사 — 지급=출금 정확 1건 · 회수=보상 입금 정확 1건(출금 쌍 잔존).
    const txs = txByPayout.get(p.id) ?? [];
    const outs = txs.filter((t) => t.direction === 'out' && t.category === 'instructor_payout').length;
    const reversals = txs.filter((t) => t.direction === 'in' && t.category === 'payout_reversal').length;
    if (p.status === 'paid') {
      if (outs !== 1) push('PAYOUT_PAID_LEDGER', p.id, `paid인데 원장 출금 ${outs}건(정확 1건 규약)`);
      if (reversals !== 0) push('PAYOUT_PAID_LEDGER', p.id, `paid인데 보상 입금 ${reversals}건(회수 아님)`);
    } else if (p.reversedAt) {
      if (outs !== 1) push('PAYOUT_REVERSAL_LEDGER', p.id, `회수인데 원장 출금 ${outs}건(append-only 쌍 규약)`);
      if (reversals !== 1) push('PAYOUT_REVERSAL_LEDGER', p.id, `회수인데 보상 입금 ${reversals}건(정확 1건 규약)`);
    } else if (outs + reversals > 0) {
      push('PAYOUT_LEDGER_UNEXPECTED', p.id, `미지급(${p.status})인데 원장 참조 ${outs + reversals}건`);
    }

    // (e-1) 활성 정산서의 lines 세션은 해당 정산서를 역참조해야 한다.
    if (isActivePayout(p)) {
      for (const l of lines) {
        const session = sessionById.get(l.sessionId);
        if (!session) push('PAYOUT_SESSION_LINK', p.id, `line 세션 ${l.sessionId} 없음`);
        else if (Number(session.payoutId) !== p.id)
          push('PAYOUT_SESSION_LINK', p.id, `line 세션 ${l.sessionId}.payoutId=${session.payoutId ?? 'NULL'} ≠ ${p.id}`);
      }
    }
  }

  // (e-2) 세션→정산서 역방향 — payoutId를 가진 세션은 그 정산서 lines에 존재해야 한다.
  const activeById = new Map(s.payouts.filter(isActivePayout).map((p) => [p.id, p]));
  for (const session of s.sessions) {
    if (session.payoutId == null) continue;
    const payout = activeById.get(Number(session.payoutId));
    if (!payout)
      issues.push({ code: 'SESSION_PAYOUT_ORPHAN', entity: 'class_sessions', entityId: session.id, message: `payoutId=${session.payoutId} → 활성 정산서 없음` });
    else if (!(payout.lines ?? []).some((l) => l.sessionId === session.id))
      issues.push({ code: 'SESSION_PAYOUT_ORPHAN', entity: 'class_sessions', entityId: session.id, message: `payoutId=${session.payoutId}인데 그 정산서 lines에 없음` });
  }

  // (f) 같은 강사 활성 정산 기간 중첩 — 이중 계상의 구조적 전조(세션 CAS가 막아도 기간은 겹치면 안 된다).
  const byInstructor = new Map<number, InstructorPayoutRow[]>();
  for (const p of s.payouts.filter(isActivePayout)) {
    const list = byInstructor.get(p.instructorId) ?? [];
    list.push(p);
    byInstructor.set(p.instructorId, list);
  }
  for (const list of byInstructor.values()) {
    const sorted = [...list].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.periodStart <= prev.periodEnd)
        warnings.push({ code: 'PAYOUT_PERIOD_OVERLAP', entity: 'instructor_payouts', entityId: cur.id, message: `강사 ${cur.instructorId} 기간 중첩: #${prev.id}(${prev.periodStart}~${prev.periodEnd}) ↔ #${cur.id}(${cur.periodStart}~${cur.periodEnd}) — 늦은 보고서 승인 등 정당 사례면 정상` });
    }
  }

  return { issues, warnings };
}
