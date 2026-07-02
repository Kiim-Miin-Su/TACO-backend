import type { CounselForm as CounselFormContract, CounselRound as CounselRoundContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// 공유 계약 형상 + 영속 감사필드(BaseRow)
export type CounselForm = CounselFormContract & BaseRow;
export type CounselRound = CounselRoundContract & BaseRow;

export const COUNSEL_FORMS = 'counsel_forms';
export const COUNSEL_ROUNDS = 'counsel_rounds';
