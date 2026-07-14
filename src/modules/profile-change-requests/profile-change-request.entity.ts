import type { BaseRow } from '../../common/types/base';

export const PROFILE_CHANGE_REQUESTS = 'profile_change_requests';

export type ProfileChangeRequestStatus = 'pending' | 'approved' | 'rejected';
export type ProfileChanges = Partial<{
  name: string;
  phone: string | null;
  countryCode: string | null;
  timeZone: string | null;
  // [TBO-29B-4] 이메일 변경 — 인증된 challenge 소비 필수(null 불가 — 삭제는 이 흐름에서 미지원).
  email: string;
}>;

/** [TBO-29B-4] 연락처 인증이 필요한 필드 — 값 설정 시 verified challenge 소비 필수. */
export const CONTACT_CHANGE_FIELDS = ['email', 'phone'] as const;

export type ProfileChangeRequest = {
  requesterId: number;
  baseProfileVersion: number;
  beforeValues: ProfileChanges;
  requestedChanges: ProfileChanges;
  reason: string;
  status: ProfileChangeRequestStatus;
  decidedBy?: number | null;
  decidedAt?: string | null;
  rejectionReason?: string | null;
  appliedProfileVersion?: number | null;
  // [TBO-29B-4] 소비한 연락처 인증 challenge(연락처 변경 요청에만 존재)
  verificationChallengeId?: number | null;
} & BaseRow;
