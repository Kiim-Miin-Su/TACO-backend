import type { CounselForm as CounselFormContract, CounselRound as CounselRoundContract, CounselStatus, CounselResult } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// 공유 계약 형상 + 영속 감사필드(BaseRow)
export type CounselForm = CounselFormContract & BaseRow;
export type CounselRound = CounselRoundContract & BaseRow;

export const COUNSEL_FORMS = 'counsel_forms';
export const COUNSEL_ROUNDS = 'counsel_rounds';

// [TBO-65 P2 M5 2026-07-26] 상담 상태·결과 유니온의 런타임 배열 진실원 — DTO(3곳)·analytics(2곳)
//  사본 수렴. satisfies가 계약과의 정합을 컴파일 타임에 강제.
export const COUNSEL_STATUSES = ['requested', 'pending', 'registered', 'dropped'] as const satisfies readonly CounselStatus[];
export const COUNSEL_RESULTS = ['positive', 'neutral', 'negative', 'no_response', 'registered'] as const satisfies readonly CounselResult[];
