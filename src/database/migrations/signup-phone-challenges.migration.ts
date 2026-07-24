export const SIGNUP_PHONE_CHALLENGES_MIGRATION_ID = '20260724_01_tbo57_signup_phone_challenges';

// [TBO-57 2026-07-24] 가입 전 휴대전화 OTP challenge 표 신설 — signup_email_challenges 미러.
//  SIGNUP_PHONE_CHALLENGES_SPEC.createSql(비운영 런타임 멱등)과 동일 DDL을 Neon 장부 기록용으로
//  공유한다. production 적용은 owner-paste(런북 §9) — 파괴적 변경 없음(신설 표 + partial index 2).
export const SIGNUP_PHONE_CHALLENGES_MIGRATION_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS signup_phone_challenges (
    id serial PRIMARY KEY,
    phone_normalized varchar(20) NOT NULL,
    purpose varchar(16) NOT NULL DEFAULT 'signup' CHECK (purpose IN ('signup','recovery')),
    code_hash varchar(64) NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','expired','locked','consumed')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
    resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 5),
    expires_at timestamptz NOT NULL,
    resend_available_at timestamptz NOT NULL,
    verified_at timestamptz,
    consumed_at timestamptz,
    consumed_by_user_id integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer,
    CONSTRAINT signup_phone_challenge_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT signup_phone_challenge_state_check CHECK (
      (status = 'pending' AND verified_at IS NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
      OR (status = 'verified' AND verified_at IS NOT NULL AND consumed_at IS NULL AND consumed_by_user_id IS NULL)
      OR (status = 'consumed' AND verified_at IS NOT NULL AND consumed_at IS NOT NULL)
      OR (status IN ('expired','locked'))
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_signup_phone_challenges_phone_status
     ON signup_phone_challenges (phone_normalized, status) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_signup_phone_challenges_expires_at
     ON signup_phone_challenges (expires_at) WHERE deleted_at IS NULL`,
];
