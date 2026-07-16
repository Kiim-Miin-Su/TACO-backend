import { studentBelongsToSession, type ParticipantEnrollment } from '../schedule/session-participant.policy';

type SessionRef = {
  id: number; courseId: number; instructorId: number; studentIds?: number[];
  payoutId?: number | null; instructorPayAmount?: number | null;
};
type AttendanceRef = { id: number; sessionId: number; studentId: number };
type ReportRef = { id: number; sessionId: number; studentId: number; instructorId: number };
type PayoutLineRef = { sessionId: number; durationMinutes: number; amount: number };
type PayoutRef = {
  id: number; status: string; sessionCount: number; totalMinutes: number;
  computedAmount: number; amount: number; adjustedAmount?: number | null; lines: PayoutLineRef[];
  reversedAt?: string | null; // [B9 E5] 지급 회수 판별(status는 rejected 재사용)
};
type TransactionRef = { id: number; direction: string; category: string; amount: number; payoutId?: number | null };

export type AccountingIntegritySnapshot = {
  sessions: readonly SessionRef[];
  attendance: readonly AttendanceRef[];
  reports: readonly ReportRef[];
  payouts: readonly PayoutRef[];
  transactions: readonly TransactionRef[];
  students: readonly { id: number }[];
  enrollments: readonly ParticipantEnrollment[];
};

export type AccountingIntegrityIssue = {
  code: string;
  entity: string;
  entityId?: number;
  message: string;
};

const issue = (code: string, entity: string, entityId: number | undefined, message: string): AccountingIntegrityIssue =>
  ({ code, entity, entityId, message });

export function checkAccountingIntegrity(snapshot: AccountingIntegritySnapshot): AccountingIntegrityIssue[] {
  const issues: AccountingIntegrityIssue[] = [];
  const sessions = new Map(snapshot.sessions.map((row) => [row.id, row]));
  const students = new Set(snapshot.students.map((row) => row.id));
  const payouts = new Map(snapshot.payouts.map((row) => [row.id, row]));
  const attendancePairs = new Set<string>();
  const reportPairs = new Set<string>();

  for (const row of snapshot.attendance) {
    const session = sessions.get(row.sessionId);
    const pair = `${row.sessionId}:${row.studentId}`;
    if (!session) issues.push(issue('ATTENDANCE_ORPHAN_SESSION', 'attendance', row.id, `session ${row.sessionId} 없음`));
    if (!students.has(row.studentId)) issues.push(issue('ATTENDANCE_ORPHAN_STUDENT', 'attendance', row.id, `student ${row.studentId} 없음`));
    if (attendancePairs.has(pair)) issues.push(issue('ATTENDANCE_DUPLICATE', 'attendance', row.id, `중복 ${pair}`));
    attendancePairs.add(pair);
    if (session && !studentBelongsToSession(session, row.studentId, snapshot.enrollments))
      issues.push(issue('ATTENDANCE_OUTSIDE_COHORT', 'attendance', row.id, `student ${row.studentId}가 session ${row.sessionId} 코호트 밖`));
  }

  for (const row of snapshot.reports) {
    const session = sessions.get(row.sessionId);
    const pair = `${row.sessionId}:${row.studentId}`;
    if (!session) issues.push(issue('REPORT_ORPHAN_SESSION', 'session_reports', row.id, `session ${row.sessionId} 없음`));
    if (!students.has(row.studentId)) issues.push(issue('REPORT_ORPHAN_STUDENT', 'session_reports', row.id, `student ${row.studentId} 없음`));
    if (reportPairs.has(pair)) issues.push(issue('REPORT_DUPLICATE', 'session_reports', row.id, `중복 ${pair}`));
    reportPairs.add(pair);
    if (session && row.instructorId !== session.instructorId)
      issues.push(issue('REPORT_INSTRUCTOR_MISMATCH', 'session_reports', row.id, `session 강사 ${session.instructorId}와 불일치`));
    if (session && !studentBelongsToSession(session, row.studentId, snapshot.enrollments))
      issues.push(issue('REPORT_OUTSIDE_COHORT', 'session_reports', row.id, `student ${row.studentId}가 session ${row.sessionId} 코호트 밖`));
  }

  const claimedSessions = new Map<number, number>();
  for (const payout of snapshot.payouts) {
    const lineIds = new Set<number>();
    for (const line of payout.lines) {
      if (lineIds.has(line.sessionId)) issues.push(issue('PAYOUT_DUPLICATE_LINE', 'instructor_payouts', payout.id, `session ${line.sessionId} 라인 중복`));
      lineIds.add(line.sessionId);
      const prior = claimedSessions.get(line.sessionId);
      if (payout.status !== 'rejected' && prior != null && prior !== payout.id)
        issues.push(issue('PAYOUT_DUPLICATE_SESSION', 'instructor_payouts', payout.id, `session ${line.sessionId}가 payout ${prior}에도 포함`));
      if (payout.status !== 'rejected') claimedSessions.set(line.sessionId, payout.id);
      const session = sessions.get(line.sessionId);
      if (!session) issues.push(issue('PAYOUT_LINE_ORPHAN_SESSION', 'instructor_payouts', payout.id, `session ${line.sessionId} 없음`));
      else if (payout.status !== 'rejected' && session.payoutId !== payout.id)
        issues.push(issue('PAYOUT_BACKREF_MISMATCH', 'instructor_payouts', payout.id, `session ${line.sessionId} payoutId=${session.payoutId ?? 'null'}`));
    }
    const totalMinutes = payout.lines.reduce((sum, line) => sum + line.durationMinutes, 0);
    const computedAmount = payout.lines.reduce((sum, line) => sum + line.amount, 0);
    if (payout.sessionCount !== payout.lines.length || payout.totalMinutes !== totalMinutes || payout.computedAmount !== computedAmount)
      issues.push(issue('PAYOUT_TOTAL_MISMATCH', 'instructor_payouts', payout.id, '라인 수/분/금액 합계 불일치'));
    if (payout.amount !== (payout.adjustedAmount ?? payout.computedAmount))
      issues.push(issue('PAYOUT_EFFECTIVE_AMOUNT_MISMATCH', 'instructor_payouts', payout.id, '실효 지급액 불일치'));
    const linked = snapshot.sessions.filter((session) => session.payoutId === payout.id);
    if (payout.status === 'rejected' && linked.length)
      issues.push(issue('REJECTED_PAYOUT_HAS_LINKS', 'instructor_payouts', payout.id, `연결 세션 ${linked.map((row) => row.id).join(',')}`));
    if (payout.status === 'paid') {
      const tx = snapshot.transactions.filter((row) => row.payoutId === payout.id && row.direction === 'out' && row.category === 'instructor_payout');
      if (tx.length !== 1 || tx[0]?.amount !== payout.amount)
        issues.push(issue('PAYOUT_TX_MISMATCH', 'instructor_payouts', payout.id, '지급 원장 1건 또는 금액 불일치'));
    }
    // [B9 E5] 지급 회수 정합 — reversedAt 있으면: 상태는 rejected(재사용 규약), 원장은 출금(지급) 1건 +
    //  입금(payout_reversal) 1건이 같은 금액으로 대사되어야 한다. 회수 안 된 정산에 보상 거래가 있으면 역방향 위반.
    const reversalTx = snapshot.transactions.filter((row) => row.payoutId === payout.id && row.direction === 'in' && row.category === 'payout_reversal');
    if (payout.reversedAt != null) {
      if (payout.status !== 'rejected')
        issues.push(issue('REVERSED_PAYOUT_BAD_STATUS', 'instructor_payouts', payout.id, `reversedAt인데 status=${payout.status}`));
      const paidTx = snapshot.transactions.filter((row) => row.payoutId === payout.id && row.direction === 'out' && row.category === 'instructor_payout');
      if (paidTx.length !== 1 || reversalTx.length !== 1 || paidTx[0]?.amount !== reversalTx[0]?.amount)
        issues.push(issue('PAYOUT_REVERSAL_TX_MISMATCH', 'instructor_payouts', payout.id, `출금 ${paidTx.length}건/입금 ${reversalTx.length}건 또는 금액 불일치`));
    } else if (reversalTx.length) {
      issues.push(issue('PAYOUT_STRAY_REVERSAL_TX', 'instructor_payouts', payout.id, `회수 아님인데 보상 거래 ${reversalTx.length}건`));
    }
  }

  for (const session of snapshot.sessions) {
    if (session.payoutId != null && !payouts.has(session.payoutId))
      issues.push(issue('SESSION_ORPHAN_PAYOUT', 'class_sessions', session.id, `payout ${session.payoutId} 없음`));
  }
  return issues;
}

export function assertAccountingIntegrity(snapshot: AccountingIntegritySnapshot): void {
  const issues = checkAccountingIntegrity(snapshot);
  if (!issues.length) return;
  throw new Error(`accounting integrity failed\n${JSON.stringify(issues, null, 2)}`);
}
