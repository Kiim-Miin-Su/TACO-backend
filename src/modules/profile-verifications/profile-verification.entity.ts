// [TBO-29B-4] 연락처 재인증 challenge — erd.dbml profile_verification_challenges와 1:1.
//  불변식: requester/channel/target 결합 · 활성(pending|verified) 1건/requester+channel ·
//  만료 10분 · 실패 5회=locked · 재전송 cooldown 60초 · consumed는 profile request 생성 tx에서만.
import type { BaseRow } from '../../common/types/base';
import type { ProfileVerificationPurpose } from '@kms545487/contracts';

export const PROFILE_VERIFICATION_CHALLENGES = 'profile_verification_challenges';

export type VerificationChannel = 'email' | 'sms';
export type VerificationStatus = 'pending' | 'verified' | 'consumed' | 'expired' | 'locked';
export type VerificationProviderName = 'email_smtp' | 'ncp_sens' | 'twilio_verify' | 'fake_test';

export type ProfileVerificationChallenge = {
  requesterId: number;
  channel: VerificationChannel;
  /** legacy는 TBO-97 이전 행/목적 누락 writer의 fail-closed 표식이며 확인·소비할 수 없다. */
  purpose: ProfileVerificationPurpose | 'legacy';
  /** email lowercase 또는 phone E.164 — API 응답·audit에는 masked만 노출 */
  targetNormalized: string;
  targetHash: string;
  provider: VerificationProviderName;
  providerReference?: string | null;
  /** 서비스 소유 OTP salted sha256(email·ncp_sens SMS) — Twilio Verify는 provider가 코드 소유(null) */
  codeHash?: string | null;
  status: VerificationStatus;
  attemptCount: number;
  resendCount: number;
  resendAvailableAt: string;
  expiresAt: string;
  verifiedAt?: string | null;
  consumedAt?: string | null;
  consumedByRequestId?: number | null;
} & BaseRow;

export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10분
export const RESEND_COOLDOWN_MS = 60 * 1000; // 60초
export const MAX_ATTEMPTS = 5;
export const MAX_RESENDS = 5;

/** 활성(확인/소비 가능) 상태 — 만료 시각은 호출부가 별도 판정. */
export const isActiveStatus = (s: VerificationStatus): boolean => s === 'pending' || s === 'verified';

export function maskTarget(channel: VerificationChannel, target: string): string {
  if (channel === 'email') {
    const [local, domain] = target.split('@');
    const dom = domain ?? '';
    const tld = dom.includes('.') ? dom.slice(dom.lastIndexOf('.')) : '';
    return `${(local ?? '').slice(0, 2)}***@${dom.slice(0, 1)}***${tld}`;
  }
  return `${target.slice(0, 3)}*****${target.slice(-3)}`;
}
