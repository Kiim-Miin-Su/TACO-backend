export const CREDENTIAL_OTP_MIGRATION_ID = '20260715_10_credential_otp';

// [E0 2026-07-15] 비밀번호 변경 본인 인증(이메일 OTP) — challenge 소비가 프로필 요청 없이도
//  가능해야 한다(자격증명 변경 소비 = consumed_by_request_id NULL). state CHECK에서 consumed의
//  request id NOT NULL 강제를 해제(NULL=자격증명 소비, NOT NULL=프로필 요청 소비).
//  PROFILE_VERIFICATION_CHALLENGES_SPEC.migrations(부팅 멱등 DO)와 SQL 공유 — Neon 장부 기록용.
export const CREDENTIAL_OTP_MIGRATION_SQL: readonly string[] = [
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'profile_verification_state_check'
         AND pg_get_constraintdef(oid) LIKE '%consumed_by_request_id IS NOT NULL%'
     ) THEN
       ALTER TABLE profile_verification_challenges DROP CONSTRAINT profile_verification_state_check;
       ALTER TABLE profile_verification_challenges ADD CONSTRAINT profile_verification_state_check CHECK (
         (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
         OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
         OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
         OR (status IN ('expired','locked'))
       );
     END IF;
   END $$`,
];
