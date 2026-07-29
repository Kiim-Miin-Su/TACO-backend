import { createHash } from 'node:crypto';
import type { ClassSession } from './schedule.entity';
import type {
  SessionAccountingImpact,
  SessionAccountingProjection,
} from '@kms545487/contracts';
export type {
  SessionAccountingImpact,
  SessionAccountingProjection,
} from '@kms545487/contracts';

export type AccountingSession = Pick<ClassSession, 'status' | 'durationMinutes'> & {
  instructorAttendance?: ClassSession['instructorAttendance'] | null;
  payoutId?: number | null;
  isPaid?: boolean;
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
  return session.payoutId != null || session.isPaid === true;
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

/** 삭제 전 영향 미리보기. 삭제 후에는 시수·정산 대상에서 완전히 제외된다. */
export function accountingImpactOfRemoval(
  session: AccountingSession,
  input: { approvedReport: boolean; hourlyRate: number },
): SessionAccountingImpact {
  return accountingImpactOf(
    session,
    { ...session, status: 'canceled' },
    {
      beforeApprovedReport: input.approvedReport,
      afterApprovedReport: false,
      beforeHourlyRate: input.hourlyRate,
      afterHourlyRate: input.hourlyRate,
    },
  );
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

/** 사용자가 본 영향 미리보기와 잠금 후 실행할 대상 집합을 결속하는 지문. */
export function accountingImpactHash(
  sessionIds: readonly number[],
  impact: SessionAccountingImpact,
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      sessionIds: [...sessionIds].sort((a, b) => a - b),
      impact,
    }))
    .digest('hex');
}
