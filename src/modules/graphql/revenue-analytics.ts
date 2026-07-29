import type {
  CeoDashboard,
  CourseProfitRow,
  EnrollmentTrendRow,
  FinanceSummary,
  RevenueAgingBucket,
  RevenueKeyAmount,
  RevenueReport,
} from '@kms545487/contracts';

// [TBO-46 G1 2026-07-23] 매출·재무 집계의 **단일 진실원 순수 함수** — GraphQL 리졸버와 e2e가 같은
//  함수를 소비한다(counsel-analytics·payout-integrity와 동일 규약). FE RevenueCharts가 브라우저에서
//  하던 전 목록 5개 클라 조인을 서버 파생으로 승격한 것.
//  실현 매출은 paidAmount ?? amount(부분 납부 반영) — 종전 FE 매출 차트(amount)와 학생 상세
//  (paidAmount??amount)가 서로 다른 값을 쓰던 불일치를 이 함수 하나로 수렴한다(문서화: TBO-46 §5).
export type RevenueSnapshot = {
  payments: Array<{
    studentId: number; enrollmentId?: number | null; amount: number; paidAmount?: number | null;
    status: string; paidAt?: string | null; dueAt?: string | null;
  }>;
  enrollments: Array<{ id: number; courseId: number; status?: string; startDate?: string | null; endDate?: string | null }>;
  courses: Array<{ id: number; name: string; subjectId: number }>;
  subjects: Array<{ id: number; name: string }>;
  students: Array<{ id: number; name: string }>;
  expenses: Array<{ amount: number; status: string; spentAt: string }>;
  payouts: Array<{ amount: number; status: string; paidAt?: string | null; lines?: Array<{ courseId: number; amount: number }> }>;
};

export type RevenueRange = { from?: string | null; to?: string | null };
export type KeyAmount = RevenueKeyAmount;

import { dayOf } from '../../common/day-range'; // [TBO-34 C3] 날짜 파생 단일 진실원
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
const sortedDesc = (bucket: Map<string, { amount: number; count: number }>): RevenueKeyAmount[] =>
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

// ── [TBO-60 2026-07-24] 대표 대시보드 파생(순수 함수) — D2 미수금 aging · D3 수강생 증감 ·
//  D6 코스 수익성. D1(financeSummary)·D4(counselFunnel)·D5(출결 요약)는 기존 파생 소비.
//  같은 RevenueSnapshot(REPEATABLE READ 한 tx)에서 전부 파생 — 리졸버 계산 금지 규약(FABLE §4.5).
export function computeCeoDashboard(snapshot: RevenueSnapshot, range: RevenueRange, todayIso: string): CeoDashboard {
  // D2 — 미수금 aging: 미납(paid 아님) 청구를 기한 경과일 기준 30/60/90 구간으로.
  const AGING = [
    { bucket: '0-30일', min: 0, max: 30 },
    { bucket: '31-60일', min: 31, max: 60 },
    { bucket: '61-90일', min: 61, max: 90 },
    { bucket: '90일+', min: 91, max: Infinity },
  ];
  const receivables: RevenueAgingBucket[] = AGING.map((b) => ({ bucket: b.bucket, amount: 0, count: 0 }));
  const dayMs = 86_400_000;
  for (const payment of snapshot.payments) {
    if (payment.status === 'paid') continue;
    const outstanding = payment.amount - (payment.paidAmount ?? 0);
    if (outstanding <= 0) continue;
    const due = payment.dueAt ? dayOf(payment.dueAt) : null;
    const overdueDays = due ? Math.max(0, Math.floor((Date.parse(todayIso) - Date.parse(due)) / dayMs)) : 0;
    const slot = AGING.findIndex((b) => overdueDays >= b.min && overdueDays <= b.max);
    const target = receivables[slot === -1 ? AGING.length - 1 : slot];
    target.amount += outstanding; target.count += 1;
  }

  // D3 — 수강생 증감: 수강 시작/종료 월별(startDate/endDate — 기간 내), 순증 = 시작 − 종료.
  const trend = new Map<string, { started: number; ended: number }>();
  const monthOf = (iso: string) => dayOf(iso).slice(0, 7);
  const bump = (month: string, key: 'started' | 'ended') => {
    const row = trend.get(month) ?? { started: 0, ended: 0 };
    row[key] += 1; trend.set(month, row);
  };
  for (const enrollment of snapshot.enrollments) {
    if (enrollment.startDate && inRange(enrollment.startDate, range)) bump(monthOf(enrollment.startDate), 'started');
    if (enrollment.endDate && inRange(enrollment.endDate, range)) bump(monthOf(enrollment.endDate), 'ended');
  }
  const enrollmentTrend: EnrollmentTrendRow[] = [...trend.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, row]) => ({ month, started: row.started, ended: row.ended, net: row.started - row.ended }));

  // D6 — 코스 수익성: 매출 = 실현 수납(paidAt 기간 내)을 enrollment→course로 귀속,
  //  비용 = 확정·지급 정산 lines의 courseId별 금액(산정 시점 스냅샷 — 이중 계상 없음).
  const courseNameOf = new Map(snapshot.courses.map((c) => [c.id, c.name]));
  const enrollmentCourse = new Map(snapshot.enrollments.map((e) => [e.id, e.courseId]));
  const profit = new Map<number, { revenue: number; cost: number }>();
  const cell = (courseId: number) => {
    const row = profit.get(courseId) ?? { revenue: 0, cost: 0 };
    profit.set(courseId, row); return row;
  };
  for (const payment of snapshot.payments) {
    if (payment.status !== 'paid' || !inRange(payment.paidAt ?? null, range)) continue;
    const courseId = payment.enrollmentId != null ? enrollmentCourse.get(payment.enrollmentId) : undefined;
    if (courseId == null) continue; // 코스 미귀속 수납은 코스 수익성 밖(재무 요약에는 포함)
    cell(courseId).revenue += payment.paidAmount ?? payment.amount;
  }
  for (const payout of snapshot.payouts) {
    if (payout.status !== 'paid' && payout.status !== 'confirmed') continue;
    for (const line of payout.lines ?? []) {
      if (line?.courseId == null) continue;
      cell(line.courseId).cost += line.amount ?? 0;
    }
  }
  const courseProfit: CourseProfitRow[] = [...profit.entries()]
    .map(([courseId, row]) => ({
      courseId, courseName: courseNameOf.get(courseId) ?? `코스 ${courseId}`,
      revenue: row.revenue, cost: row.cost, profit: row.revenue - row.cost,
    }))
    .sort((a, b) => b.profit - a.profit || a.courseId - b.courseId);

  return {
    from: range.from ?? null, to: range.to ?? null,
    finance: computeFinanceSummary(snapshot, range),
    receivables, enrollmentTrend, courseProfit,
  };
}
