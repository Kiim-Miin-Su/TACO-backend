// [2026-07-16 SENS 활성화 준비] SMS 인증 가용성 단일 판정 — provider env 완비 여부.
//  · 종전엔 profile-change-requests.service의 private 헬퍼였으나, FE가 스테퍼를 동적으로
//    켜고 끌 수 있도록 프로필 응답(smsVerificationAvailable)에도 노출한다(코드 수정 없는 활성화:
//    NCP_SENS_* env 투입 → BE 인증 요구 + FE 스테퍼가 동시에 켜짐 / 제거 시 동시 꺼짐).
//  · ⚠ 발신번호 사전등록이 승인되기 전에는 env를 넣지 말 것 — 넣는 순간 인증이 '필수'가 되는데
//    발송이 실패해 전화번호 변경이 막힌다(2026-07-16 대표: 발신번호 승인 대기중 → env 주석 권고).
export function smsChallengeAvailable(): boolean {
  const twilio = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID;
  return sensChallengeAvailable() || Boolean(twilio);
}

// [TBO-57 2026-07-24] 가입 폼 휴대전화 OTP 가용성 — **SENS 전용** 판정. Twilio Verify(legacy,
//  provider 코드 소유)는 마이페이지 재인증 fallback으로만 남기고, 공개 가입 흐름은 서비스 코드
//  소유(hash 대조) 규약이 강제되는 SENS만 지원한다(signup-phone-challenges.service 상단 주석).
export function sensChallengeAvailable(): boolean {
  return [
    ncpSensAccessKey(),
    process.env.NCP_SENS_SECRET_KEY,
    process.env.NCP_SENS_SERVICE_ID,
    process.env.NCP_SENS_FROM,
  ].every((value) => Boolean(value?.trim()));
}

/** NCP 콘솔 명칭(Access Key ID)을 정본으로 사용하고 기존 배포 키는 호환용으로만 허용한다. */
export function ncpSensAccessKey(): string | undefined {
  return process.env.NCP_SENS_ACCESS_KEY_ID?.trim()
    || process.env.NCP_SENS_ACCESS_KEY?.trim()
    || undefined;
}
