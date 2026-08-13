export const PROFILE_VERIFICATION_PURPOSE_MIGRATION_ID =
  '20260813_01_tbo97_profile_verification_purpose';

export const PROFILE_VERIFICATION_PURPOSE_CHECK =
  'profile_verification_purpose_check';

/**
 * `legacy`는 구버전 writer 및 적용 전 행을 fail-closed로 식별한다. 새 backend는 항상 명시 목적을
 * 저장하며 legacy challenge를 확인·재전송·소비하지 않는다.
 */
export const PROFILE_VERIFICATION_PURPOSE_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE profile_verification_challenges
     ADD COLUMN IF NOT EXISTS purpose varchar(32) NOT NULL DEFAULT 'legacy'`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname='profile_verification_purpose_check'
          AND conrelid='public.profile_verification_challenges'::regclass
     ) THEN
       ALTER TABLE profile_verification_challenges
         ADD CONSTRAINT profile_verification_purpose_check
         CHECK (purpose IN ('legacy','profile_change','password_change','account_setup')) NOT VALID;
     END IF;
   END $$`,
  `ALTER TABLE profile_verification_challenges
     VALIDATE CONSTRAINT profile_verification_purpose_check`,
];
