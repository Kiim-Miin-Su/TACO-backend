// [TBO-46 G1 2026-07-23] 매출·재무 집계의 **단일 진실원 순수 함수** — GraphQL 리졸버와 e2e가 같은
//  함수를 소비한다(counsel-analytics·payout-integrity와 동일 규약). FE RevenueCharts가 브라우저에서
//  하던 전 목록 5개 클라 조인을 서버 파생으로 승격한 것.
//  실현 매출은 paidAmount ?? amount(부분 납부 반영) — 종전 FE 매출 차트(amount)와 학생 상세
//  (paidAmount??amount)가 서로 다른 값을 쓰던 불일치를 이 함수 하나로 수렴한다(문서화: TBO-46 §5).
export type RevenueSnapshot = {
  payments: Array<{
    studentId: number; enrollmentId?: number | null; amount: number; paidAmount?: number | null;
    status: string; paidAt?: string | null;
  }>;
  enrollments: Array<{ id: number; courseId: number }>;
  courses: Array<{ id: number; name: string; subjectId: number }>;
  subjects: Array<{ id: number; name: string }>;
  students: Array<{ id: number; name: string }>;
  expenses: Array<{ amount: number; status: string; spentAt: string }>;
  payouts: Array<{ amount: number; status: string; paidAt?: string | null }>;
};

export type RevenueRange = { from?: string | null; to?: string | null };
export type KeyAmount = { key: string; amount: number; count: number };

export type RevenueReport = {
  from: string | null; to: string | null;
  realizedTotal: number; unpaidTotal: number; unpaidCount: number;
  byMonth: KeyAmount[]; bySubject: KeyAmount[]; byCourse: KeyAmount[]; byStudent: KeyAmount[];
};

export type FinanceSummary = {
  from: string | null; to: string | null;
  revenue: number; expenses: number; payouts: number; net: number;
};

const dayOf = (iso: string): string => iso.slice(0, 10);
const inRange = (iso: string | null | undefined, range: RevenueRange): boolean => {
  if (!iso) return false;
  const day = dayOf(iso);
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
};

const accumulate = (bucket: Map<string, { amount: number; count: number }>, key: string, amount: number) => {
  const row = bucket.get(key) ?? { amount: 0, count: 0 };
  row.amount += amount; row.count += 1;
  bucket.set(key, row);
};
const sortedDesc = (bucket: Map<string, { amount: number; count: number }>): KeyAmount[] =>
  [...bucket.entries()].sort((a, b) => b[1].amount - a[1].amount || a[0].localeCompare(b[0]))
    .map(([key, v]) => ({ key, ...v }));

export function computeRevenueReport(snapshot: RevenueSnapshot, range: RevenueRange = {}): RevenueReport {
  const courseById = new Map(snapshot.courses.map((c) => [c.id, c]));
  const subjectNameById = new Map(snapshot.subjects.map((s) => [s.id, s.name]));
  const studentNameById = new Map(snapshot.students.map((s) => [s.id, s.name]));
  const enrollmentById = new Map(snapshot.enrollments.map((e) => [e.id, e]));

  const byMonth = new Map<string, { amount: number; count: number }>();
  const bySubject = new Map<string, { amount: number; count: number }>();
  const byCourse = new Map<string, { amount: number; count: number }>();
  const byStudent = new Map<string, { amount: number; count: number }>();
  let realizedTotal = 0, unpaidTotal = 0, unpaidCount = 0;

  for (const payment of snapshot.payments) {
    if (payment.status === 'paid' && inRange(payment.paidAt, range)) {
      const realized = payment.paidAmount ?? payment.amount;
      realizedTotal += realized;
      accumulate(byMonth, dayOf(payment.paidAt as string).slice(0, 7), realized);
      accumulate(byStudent, studentNameById.get(payment.studentId) ?? `학생 #${payment.studentId}`, realized);
      const enrollment = payment.enrollmentId != null ? enrollmentById.get(payment.enrollmentId) : undefined;
      const course = enrollment ? courseById.get(enrollment.courseId) : undefined;
      accumulate(byCourse, course?.name ?? '기타(수강 미연결)', realized);
      accumulate(bySubject, course ? (subjectNameById.get(course.subjectId) ?? '기타') : '기타(수강 미연결)', realized);
    }
    if (payment.status === 'pending' || payment.status === 'overdue') {
      unpaidTotal += payment.amount;
      unpaidCount += 1;
    }
  }
  return {
    from: range.from ?? null, to: range.to ?? null,
    realizedTotal, unpaidTotal, unpaidCount,
    byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => ({ key, ...v })),
    bySubject: sortedDesc(bySubject), byCourse: sortedDesc(byCourse), byStudent: sortedDesc(byStudent),
  };
}

export function computeFinanceSummary(snapshot: RevenueSnapshot, range: RevenueRange = {}): FinanceSummary {
  const revenue = computeRevenueReport(snapshot, range).realizedTotal;
  const expenses = snapshot.expenses
    .filter((e) => e.status === 'approved' && inRange(e.spentAt, range))
    .reduce((acc, e) => acc + e.amount, 0);
  const payouts = snapshot.payouts
    .filter((p) => p.status === 'paid' && inRange(p.paidAt, range))
    .reduce((acc, p) => acc + p.amount, 0);
  return { from: range.from ?? null, to: range.to ?? null, revenue, expenses, payouts, net: revenue - expenses - payouts };
}
