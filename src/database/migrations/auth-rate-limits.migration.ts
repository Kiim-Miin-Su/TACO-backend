export const AUTH_RATE_LIMITS_MIGRATION_ID = '20260720_02_tbo34_auth_rate_limits';

export const AUTH_RATE_LIMITS_MIGRATION_SQL = [
  `CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key_hash varchar(64) PRIMARY KEY,
    throttler_name varchar(40) NOT NULL,
    total_hits integer NOT NULL DEFAULT 0 CHECK (total_hits >= 0),
    window_expires_at timestamptz NOT NULL,
    blocked_until timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_expiry
     ON auth_rate_limits (window_expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_blocked
     ON auth_rate_limits (blocked_until) WHERE blocked_until IS NOT NULL`,
] as const;
