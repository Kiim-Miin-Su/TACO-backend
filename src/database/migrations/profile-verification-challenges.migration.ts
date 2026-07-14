export const PROFILE_VERIFICATION_CHALLENGES_MIGRATION_ID = '20260714_03_profile_verification_challenges';

// [TBO-29B-4] 연락처 재인증 challenge 자산 + profile_change_requests 확장(email 허용 key·challenge FK).
//  규약: challenge는 requester/channel/canonical target에 결합, 일회 소비, 만료·실패횟수·재전송 cooldown을
//  DB에 영속화한다(process-local limit만으로 판정 금지 — TBO-29B-4 §7). 평문 코드/비밀번호/secret 저장 금지.
export const PROFILE_VERIFICATION_CHALLENGES_MIGRATION_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS profile_verification_challenges (
     id serial PRIMARY KEY,
     requester_id integer NOT NULL REFERENCES users(id),
     channel varchar(16) NOT NULL CHECK (channel IN ('email','sms')),
     target_normalized varchar(320) NOT NULL,
     target_hash varchar(64) NOT NULL,
     provider varchar(32) NOT NULL CHECK (provider IN ('email_smtp','twilio_verify','fake_test')),
     provider_reference varchar(128),
     code_hash varchar(128),
     status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','consumed','expired','locked')),
     attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
     resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 5),
     resend_available_at timestamptz NOT NULL,
     expires_at timestamptz NOT NULL,
     verified_at timestamptz,
     consumed_at timestamptz,
     consumed_by_request_id integer REFERENCES profile_change_requests(id),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     deleted_at timestamptz,
     deleted_by integer REFERENCES users(id),
     CONSTRAINT profile_verification_expiry_check CHECK (expires_at > created_at),
     CONSTRAINT profile_verification_state_check CHECK (
       (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
       OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_request_id IS NULL)
       OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL AND consumed_by_request_id IS NOT NULL)
       OR (status IN ('expired','locked'))
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_verification_active_requester_channel
     ON profile_verification_challenges (requester_id, channel)
     WHERE status IN ('pending','verified') AND deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_profile_verification_requester_status
     ON profile_verification_challenges (requester_id, status) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_profile_verification_channel_target
     ON profile_verification_challenges (channel, target_hash, status) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_profile_verification_expires_at
     ON profile_verification_challenges (expires_at) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_profile_verification_consumed_by
     ON profile_verification_challenges (consumed_by_request_id) WHERE deleted_at IS NULL`,
  // profile_change_requests 확장: email 허용 key + 소비된 challenge 역참조
  `ALTER TABLE profile_change_requests ADD COLUMN IF NOT EXISTS verification_challenge_id integer REFERENCES profile_verification_challenges(id)`,
  `ALTER TABLE profile_change_requests DROP CONSTRAINT IF EXISTS profile_change_requested_keys_check`,
  `ALTER TABLE profile_change_requests ADD CONSTRAINT profile_change_requested_keys_check CHECK (
     jsonb_typeof(requested_changes) = 'object'
     AND requested_changes <> '{}'::jsonb
     AND requested_changes - ARRAY['name','phone','countryCode','timeZone','email'] = '{}'::jsonb
   )`,
];
