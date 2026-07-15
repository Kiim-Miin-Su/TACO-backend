export const SENS_PROVIDER_MIGRATION_ID = '20260715_03_sens_provider';

// [2026-07-15 SENS 전환] profile_verification_challenges.provider CHECK에 'ncp_sens' 허용 추가.
//  provider CHECK는 20260714_03에서 인라인(무명명)으로 생성돼 자동 이름이 배포마다 다를 수 있어
//  이름이 아니라 **정의 내용**('email_smtp' 포함 + 'ncp_sens' 미포함)으로 구 제약을 찾아 교체한다.
//  멱등: 이미 ncp_sens를 허용하면 no-op. 런타임 부팅 DDL(스펙 migrations)과 SQL 원문을 공유한다.
export const SENS_PROVIDER_MIGRATION_SQL: readonly string[] = [
  `DO $$
   DECLARE c record;
   BEGIN
     FOR c IN
       SELECT conname FROM pg_constraint
       WHERE conrelid = 'profile_verification_challenges'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%email_smtp%'
         AND pg_get_constraintdef(oid) NOT LIKE '%ncp_sens%'
     LOOP
       EXECUTE format('ALTER TABLE profile_verification_challenges DROP CONSTRAINT %I', c.conname);
     END LOOP;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'profile_verification_challenges'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%ncp_sens%'
     ) THEN
       ALTER TABLE profile_verification_challenges ADD CONSTRAINT profile_verification_challenges_provider_check
         CHECK (provider IN ('email_smtp','ncp_sens','twilio_verify','fake_test'));
     END IF;
   END $$`,
];
