import type { ClassSession } from './schedule.entity';

export type AccountingSession = Pick<ClassSession, 'status' | 'durationMinutes'> & {
  instructorAttendance?: ClassSession['instructorAttendance'] | null;
  payoutId?: number | null;
};

export type SessionAccountingProjection = {
  teachingMinutes: number;
  payoutEligibleMinutes: number;
  computedAmount: number;
};

export type SessionAccountingImpact = {
  changed: boolean;
  payoutId?: number | null;
  before: SessionAccountingProjection;
  after: SessionAccountingProjection;
  delta: SessionAccountingProjection;
};

/** 시수와 정산이 공유하는 수업 인정 규칙의 단일 소스. */
export function countsForTeachingHours(session: AccountingSession): boolean {
  return session.status === 'held' && session.instructorAttendance !== 'absent';
}

export function teachingMinutesOf(session: AccountingSession): number {
  return countsForTeachingHours(session) ? session.durationMinutes : 0;
}

/** 이미 정산 스냅샷에 연결된 세션은 정산 회수 전까지 회계 필드를 바꿀 수 없다. */
export function isPayoutLocked(session: AccountingSession): boolean {
  return session.payoutId != null;
}

export function payoutIdOf(session: AccountingSession): number | null | undefined {
  return session.payoutId;
}

/** 시수 -> 정산 금액 환산의 단일 소스 — 정산 미리보기(accountingProjectionOf)와 정산서 라인 산정이 공유. */
export function payoutAmountOf(minutes: number, hourlyRate: number): number {
  return Math.round((minutes / 60) * hourlyRate);
}

export function accountingProjectionOf(
  session: AccountingSession,
  input: { approvedReport: boolean; hourlyRate: number },
): SessionAccountingProjection {
  const teachingMinutes = teachingMinutesOf(session);
  const payoutEligibleMinutes = input.approvedReport ? teachingMinutes : 0;
  return {
    teachingMinutes,
    payoutEligibleMinutes,
    computedAmount: payoutAmountOf(payoutEligibleMinutes, input.hourlyRate),
  };
}

export function accountingImpactOf(
  beforeSession: AccountingSession,
  afterSession: AccountingSession,
  input: { beforeApprovedReport: boolean; afterApprovedReport: boolean; beforeHourlyRate: number; afterHourlyRate: number },
): SessionAccountingImpact {
  const before = accountingProjectionOf(beforeSession, {
    approvedReport: input.beforeApprovedReport,
    hourlyRate: input.beforeHourlyRate,
  });
  const after = accountingProjectionOf(afterSession, {
    approvedReport: input.afterApprovedReport,
    hourlyRate: input.afterHourlyRate,
  });
  const delta = {
    teachingMinutes: after.teachingMinutes - before.teachingMinutes,
    payoutEligibleMinutes: after.payoutEligibleMinutes - before.payoutEligibleMinutes,
    computedAmount: after.computedAmount - before.computedAmount,
  };
  return {
    changed: Object.values(delta).some((value) => value !== 0),
    payoutId: payoutIdOf(beforeSession),
    before,
    after,
    delta,
  };
}

export function combineAccountingImpacts(impacts: readonly SessionAccountingImpact[]): SessionAccountingImpact {
  const sum = (side: 'before' | 'after' | 'delta'): SessionAccountingProjection => impacts.reduce(
    (acc, impact) => ({
      teachingMinutes: acc.teachingMinutes + impact[side].teachingMinutes,
      payoutEligibleMinutes: acc.payoutEligibleMinutes + impact[side].payoutEligibleMinutes,
      computedAmount: acc.computedAmount + impact[side].computedAmount,
    }),
    { teachingMinutes: 0, payoutEligibleMinutes: 0, computedAmount: 0 },
  );
  return {
    changed: impacts.some((impact) => impact.changed),
    payoutId: impacts.find((impact) => impact.payoutId != null)?.payoutId,
    before: sum('before'),
    after: sum('after'),
    delta: sum('delta'),
  };
}
