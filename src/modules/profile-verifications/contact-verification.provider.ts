// [TBO-29B-4 §4] Provider 경계 — controller/service가 SDK/전송기를 직접 호출하지 않는다.
//  · email: 서비스가 OTP를 생성해 send()로 전달(저장은 salted hash만) → 확인은 서비스가 hash 대조.
//  · sms(NCP SENS — 기본): 단순 발송 API라 코드 소유권이 서비스에 있다(email과 동일 hash 대조).
//  · sms(Twilio Verify — legacy fallback): provider가 코드를 생성/보관 → 확인은 check() 위임.
//    → 발송 전 코드 생성 여부는 ownsCode()로 판정하고, 확인 경로는 challenge.codeHash 존재 여부로
//      판정한다(발송 후 provider 설정이 바뀌어도 진행 중 challenge는 발송 당시 규약 유지).
//  · production에서 채널 설정이 없으면 fail-closed(자동 성공/dev fallback 금지).
//  · 테스트는 DI로 deterministic fake를 주입(실 발송 0).
import type { VerificationChannel, VerificationProviderName } from './profile-verification.entity';
import type { VerificationPurpose } from '@kms545487/contracts';

export const CONTACT_VERIFICATION_PROVIDER = 'CONTACT_VERIFICATION_PROVIDER';

export type SendChallengeInput = {
  channel: VerificationChannel;
  purpose: VerificationPurpose;
  /** canonical target — email lowercase 또는 E.164 */
  target: string;
  /** 서비스가 코드를 소유하는 채널(ownsCode=false): 서비스 생성 OTP(발송 후 즉시 폐기 — provider 저장 금지) */
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
  /** true면 provider가 코드를 생성/보관(check 위임), false면 서비스가 생성·hash 대조. */
  ownsCode(channel: VerificationChannel): boolean;
  send(input: SendChallengeInput): Promise<ProviderChallenge>;
  check(input: CheckChallengeInput): Promise<ProviderCheckResult>;
}
