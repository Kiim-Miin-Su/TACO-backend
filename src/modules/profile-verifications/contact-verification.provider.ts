// [TBO-29B-4 §4] Provider 경계 — controller/service가 SDK/전송기를 직접 호출하지 않는다.
//  · email: 서비스가 OTP를 생성해 send()로 전달(저장은 salted hash만) → 확인은 서비스가 hash 대조.
//  · sms(Twilio Verify): provider가 코드를 생성/보관 → 확인은 check() 위임(provider_reference 사용).
//  · production에서 채널 설정이 없으면 fail-closed(자동 성공/dev fallback 금지).
//  · 테스트는 DI로 deterministic fake를 주입(실 발송 0).
import type { VerificationChannel, VerificationProviderName } from './profile-verification.entity';

export const CONTACT_VERIFICATION_PROVIDER = 'CONTACT_VERIFICATION_PROVIDER';

export type SendChallengeInput = {
  channel: VerificationChannel;
  /** canonical target — email lowercase 또는 E.164 */
  target: string;
  /** email 채널: 서비스가 생성한 OTP(발송 후 즉시 폐기 — provider는 저장 금지) */
  code?: string;
};

export type ProviderChallenge = {
  provider: VerificationProviderName;
  providerReference?: string | null;
};

export type CheckChallengeInput = {
  channel: VerificationChannel;
  target: string;
  code: string;
  providerReference?: string | null;
};

export type ProviderCheckResult = { ok: boolean };

export interface ContactVerificationProvider {
  send(input: SendChallengeInput): Promise<ProviderChallenge>;
  check(input: CheckChallengeInput): Promise<ProviderCheckResult>;
}
