import { createHash } from 'node:crypto';
import type { ClassSession } from './schedule.entity';
import type {
  PayoutWorksheetManualReason,
  PayoutWorksheetPricing,
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
  /** 관리자 책정가(override). 있으면 자동 산정보다 우선한다. */
  instructorPayAmount?: number | null;
};

/**
 * 가격 분류 입력 — 정산서 라인 산정(payouts)과 회계 영향 미리보기(schedule)가 **같은** 입력을 쓴다.
 * [TBO-79 B1] 종전엔 미리보기가 `approvedReport: boolean` 하나만 받아 지각·학생 출결 미기록·
 *  책정가를 보지 못했다. 그래서 present→late 전이가 delta 0으로 계산돼 ack 없이 통과하는데
 *  실제 정산 preview에서는 라인이 통째로 빠지는 불일치가 있었다.
 */
export type SessionPricingInput = {
  /** 세션의 실제 참가자 id 목록(코호트 판정 결과). */
  participantIds: readonly number[];
  /** (session, student)별 리포트 — participantIds 순서 무관. */
  reportOf: (studentId: number) => { approvalStatus?: string | null } | undefined;
  /** (session, student)별 학생 출결 상태 — undefined = 미기록. */
  attendanceOf: (studentId: number) => string | undefined;
  hourlyRate: number | undefined;
};

/** 시수 인정 규칙 — "강사가 실제로 가르쳤는가"(지각 포함, 결석만 제외). */
export function countsForTeachingHours(session: AccountingSession): boolean {
  return session.status === 'held' && session.instructorAttendance !== 'absent';
}

export function reportsComplete(
  participantIds: readonly number[],
  reportOf: SessionPricingInput['reportOf'],
): boolean {
  if (participantIds.length === 0) return false;
  return participantIds.every((studentId) => reportOf(studentId)?.approvalStatus === 'approved');
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

/**
 * 회차 하나의 가격 분류 — 워크시트·preview·generate·회계 영향 미리보기 공용(단일 진실원).
 *
 * [TBO-64 2026-07-24] 분류(대표 지시 ⑤·⑦·⑧ + 기간설정 지시 ①):
 *  · auto     — held ∧ 강사 출결 ∈ {출석·미표시·보강} ∧ 전 참가자 학생 출결 기록됨 ∧
 *               전 코호트 리포트 승인 ∧ 시급>0 → 기본값 = 시급×시간. 책정가가 있으면 우선.
 *  · manual   — held ∧ 결석 아님 ∧ (지각 ∨ 학생 출결 미기록 ∨ 리포트 미승인 ∨ roster 없음 ∨
 *               시급 미설정) → 책정 전 amount=null(합계 제외). 매니저/대표가 직접 입력해야 포함.
 *  · excluded — 결석·미진행(scheduled 등)·이미 정산 연결·지급 완료.
 *
 * [TBO-79 B1] 소유가 payouts → schedule로 이동했다. payouts는 재export로 소비한다.
 *  이유: 회계 영향 미리보기(schedule)가 이 분류를 소비해야 하는데 payouts가 schedule을
 *  의존하고 있어 반대 방향 import는 순환이 된다.
 */
export function classifySessionForPayout(
  session: AccountingSession,
  input: SessionPricingInput,
): PayoutWorksheetPricing {
  const override = session.instructorPayAmount ?? null;
  const base = { overrideAmount: override } as const;

  if (session.payoutId != null || session.isPaid === true) {
    return { kind: 'excluded', manualReasons: [], excludedReason: 'payout_linked', autoAmount: null, effectiveAmount: null, ...base };
  }
  if (session.status !== 'held') {
    return { kind: 'excluded', manualReasons: [], excludedReason: 'not_held', autoAmount: null, effectiveAmount: null, ...base };
  }
  if (session.instructorAttendance === 'absent') {
    return { kind: 'excluded', manualReasons: [], excludedReason: 'instructor_absent', autoAmount: null, effectiveAmount: null, ...base };
  }

  const manualReasons: PayoutWorksheetManualReason[] = [];
  if (session.instructorAttendance === 'late') manualReasons.push('late');
  if (input.participantIds.length === 0) manualReasons.push('roster_missing');
  else {
    // [기간설정 지시 ① 2026-07-24] 출결·리포트 "둘 중 하나라도 이상" = 자동 계산 금지 → 직접 입력.
    if (input.participantIds.some((studentId) => input.attendanceOf(studentId) == null)) manualReasons.push('attendance_missing');
    if (!reportsComplete(input.participantIds, input.reportOf)) manualReasons.push('report_incomplete');
  }
  if (input.hourlyRate == null || input.hourlyRate <= 0) manualReasons.push('rate_missing');

  if (manualReasons.length > 0) {
    return { kind: 'manual', manualReasons, autoAmount: null, effectiveAmount: override, ...base };
  }
  const autoAmount = payoutAmountOf(session.durationMinutes, input.hourlyRate!);
  return { kind: 'auto', manualReasons: [], autoAmount, effectiveAmount: override ?? autoAmount, ...base };
}

/**
 * 회계 영향 미리보기의 한 회차 투영.
 *
 * [TBO-79 B1] 정산 예상액은 정산서 라인 산정과 **같은 분류 함수**를 소비한다.
 *  정산 연결(payoutId/isPaid)은 가격 규칙이 아니라 lifecycle 가드(PAYOUT_REVERSAL_REQUIRED)가
 *  따로 처리하므로, 투영에서는 링크 상태를 벗기고 가격 규칙만 적용한다 — 그래야 "정산 회수 후
 *  이 변경이 만들 금액"을 정확히 보여준다.
 *  teachingMinutes(시수)는 종전 정의를 유지한다 — 지각도 가르친 시간이다. 달라지는 건
 *  payoutEligibleMinutes·computedAmount(정산 예상액)뿐이다.
 */
export function accountingProjectionOf(
  session: AccountingSession,
  input: SessionPricingInput,
): SessionAccountingProjection {
  const teachingMinutes = teachingMinutesOf(session);
  const pricing = classifySessionForPayout({ ...session, payoutId: null, isPaid: false }, input);
  return {
    teachingMinutes,
    payoutEligibleMinutes: pricing.effectiveAmount == null ? 0 : teachingMinutes,
    computedAmount: pricing.effectiveAmount ?? 0,
  };
}

export function accountingImpactOf(
  beforeSession: AccountingSession,
  afterSession: AccountingSession,
  input: { before: SessionPricingInput; after: SessionPricingInput },
): SessionAccountingImpact {
  const before = accountingProjectionOf(beforeSession, input.before);
  const after = accountingProjectionOf(afterSession, input.after);
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
  input: SessionPricingInput,
): SessionAccountingImpact {
  return accountingImpactOf(
    session,
    { ...session, status: 'canceled' },
    { before: input, after: input },
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
