// [TBO-64 2026-07-24] 시수 워크시트 가격 정책 — 단일 진실원(대표 지시 ⑩).
//  워크시트(GET /payouts/worksheet)·preview·generate가 이 분류 하나를 공유한다.
//
//  분류(대표 지시 ⑤·⑦·⑧ + 2026-07-24 기간설정 지시 ①):
//   · auto     — held ∧ 강사 출결 ∈ {출석·미표시·보강} ∧ **전 참가자 학생 출결 기록됨** ∧
//                전 코호트 리포트 승인 ∧ 시급>0 → 기본값 = 시급×시간(payoutAmountOf).
//                책정가(override)가 있으면 책정가 우선.
//   · manual   — held ∧ 결석 아님 ∧ (지각 ∨ **학생 출결 미기록** ∨ 리포트 미작성/미승인/반려 ∨
//                roster 없음 ∨ 시급 미설정) → 책정 전 amount=null(빈칸 — 합계 제외),
//                매니저/대표가 **정수 금액을 직접 입력**해야 포함(대표 지시 "출결·리포트 둘 중
//                하나라도 이상이 있으면 직접 int 입력").
//   · excluded — 결석·취소/노쇼/미진행(scheduled)·이미 정산 연결(payoutId)·지급 완료.
//
//  정책 변화 명시: 종전엔 지각도 자동 포함(countsForTeachingHours가 absent만 제외)·리포트
//  미완은 적격 탈락이었다 → 이제 둘 다 "책정 필요(manual)"로 통일(TBO-64 §1).
import type { SessionReportRow } from '../reports/report.entity';
import type { ClassSession } from '../schedule/schedule.entity';
import { payoutAmountOf } from '../schedule/session-accounting.policy';
import type {
  PayoutWorksheet as SharedPayoutWorksheet,
  PayoutWorksheetExcludedReason,
  PayoutWorksheetManualReason,
  PayoutWorksheetParticipant as SharedPayoutWorksheetParticipant,
  PayoutWorksheetPricing,
  PayoutWorksheetPricingKind,
  PayoutWorksheetRow as SharedPayoutWorksheetRow,
} from '@kms545487/contracts';

export type WorksheetSession = ClassSession & {
  payoutId?: number | null;
  isPaid?: boolean;
  instructorPayAmount?: number | null;
};

export type WorksheetPricingKind = PayoutWorksheetPricingKind;
export type WorksheetManualReason = PayoutWorksheetManualReason;
export type WorksheetExcludedReason = PayoutWorksheetExcludedReason;
export type WorksheetClassification = PayoutWorksheetPricing;

export type ClassifyInput = {
  /** 세션의 실제 참가자 id 목록(코호트 판정 결과). */
  participantIds: readonly number[];
  /** (session, student)별 리포트 — participantIds 순서 무관. */
  reportOf: (studentId: number) => SessionReportRow | undefined;
  /** (session, student)별 학생 출결 상태 — undefined = 미기록(기간설정 지시 ①). */
  attendanceOf: (studentId: number) => string | undefined;
  hourlyRate: number | undefined;
};

export function reportsComplete(participantIds: readonly number[], reportOf: ClassifyInput['reportOf']): boolean {
  if (participantIds.length === 0) return false;
  return participantIds.every((studentId) => reportOf(studentId)?.approvalStatus === 'approved');
}

/** 회차 하나의 가격 분류 — 워크시트·preview·generate 공용(단일 진실원). */
export function classifySessionForPayout(session: WorksheetSession, input: ClassifyInput): WorksheetClassification {
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

  const manualReasons: WorksheetManualReason[] = [];
  if (session.instructorAttendance === 'late') manualReasons.push('late');
  if (input.participantIds.length === 0) manualReasons.push('roster_missing');
  else {
    // [기간설정 지시 ① 2026-07-24] 출결·리포트 "둘 중 하나라도 이상" = 자동 계산 금지 → 직접 입력.
    //  학생 출결 미기록(출결 현황 미완성)도 이상으로 판정 — 종전엔 리포트만 봤다(정책 강화 명시).
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

export type PayoutWorksheetParticipant = SharedPayoutWorksheetParticipant;
export type PayoutWorksheetRow = SharedPayoutWorksheetRow;
export type PayoutWorksheet = SharedPayoutWorksheet;
