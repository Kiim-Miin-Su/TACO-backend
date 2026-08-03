import { ROLE_CAPABILITIES } from '@kms545487/contracts';

export const USER_CAPABILITY_OVERRIDES_MIGRATION_ID = '20260803_02_tbo82_user_capability_overrides';

const capabilityDomain = ROLE_CAPABILITIES.map((capability) => `'${capability}'`).join(',');

export const USER_CAPABILITY_OVERRIDES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS user_capability_overrides (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES users(id),
    capability varchar(64) NOT NULL,
    effect varchar(16) NOT NULL,
    reason varchar(200) NOT NULL,
    created_by integer NOT NULL REFERENCES users(id),
    updated_by integer NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer REFERENCES users(id),
    CONSTRAINT c_user_capability_overrides_capability CHECK (capability IN (${capabilityDomain})),
    CONSTRAINT c_user_capability_overrides_effect CHECK (effect IN ('allow','deny')),
    CONSTRAINT c_user_capability_overrides_reason CHECK (char_length(btrim(reason)) BETWEEN 5 AND 200)
  )
`;

export const USER_CAPABILITY_OVERRIDES_INDEX_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_capability_override_active
     ON user_capability_overrides (user_id, capability) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_user_capability_override_lookup
     ON user_capability_overrides (user_id, capability) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_user_capability_override_actor
     ON user_capability_overrides (updated_by, updated_at DESC) WHERE deleted_at IS NULL`,
] as const;

export const USER_CAPABILITY_OVERRIDES_MIGRATION_SQL = [
  USER_CAPABILITY_OVERRIDES_TABLE_SQL,
  ...USER_CAPABILITY_OVERRIDES_INDEX_SQL,
] as const;
