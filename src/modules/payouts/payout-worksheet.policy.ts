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
import type { ClassSession } from '../schedule/schedule.entity';
import type { SessionPricingInput } from '../schedule/session-accounting.policy';
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

// [TBO-79 B1] 분류 함수의 소유가 schedule/session-accounting.policy로 이동했다.
//  이유: 회계 영향 미리보기(schedule)가 같은 분류를 소비해야 하는데, payouts가 이미 schedule을
//  의존하므로 반대 방향 import는 순환이 된다. 여기서는 재export만 한다 — 사본을 만들지 말 것.
export type ClassifyInput = SessionPricingInput;
export { classifySessionForPayout, reportsComplete } from '../schedule/session-accounting.policy';

export type PayoutWorksheetParticipant = SharedPayoutWorksheetParticipant;
export type PayoutWorksheetRow = SharedPayoutWorksheetRow;
export type PayoutWorksheet = SharedPayoutWorksheet;
