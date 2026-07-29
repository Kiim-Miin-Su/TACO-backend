import type {
  ProfileChangeFields,
  ProfileChangeRequest as ProfileChangeRequestContract,
  ProfileChangeRequestStatus,
} from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export const PROFILE_CHANGE_REQUESTS = 'profile_change_requests';

export type { ProfileChangeRequestStatus };
export type ProfileChanges = ProfileChangeFields;

/** [TBO-29B-4] 연락처 인증이 필요한 필드 — 값 설정 시 verified challenge 소비 필수. */
export const CONTACT_CHANGE_FIELDS = ['email', 'phone'] as const;

export type ProfileChangeRequest = ProfileChangeRequestContract & BaseRow & {
  // [TBO-29B-4] 소비한 연락처 인증 challenge(연락처 변경 요청에만 존재)
  verificationChallengeId?: number | null;
};
