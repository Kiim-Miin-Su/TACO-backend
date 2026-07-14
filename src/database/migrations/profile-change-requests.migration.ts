export const PROFILE_CHANGE_REQUESTS_MIGRATION_ID = '20260714_02_profile_change_requests';

export const PROFILE_CHANGE_REQUESTS_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_version integer NOT NULL DEFAULT 1`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_profile_version_check') THEN
       ALTER TABLE users ADD CONSTRAINT users_profile_version_check CHECK (profile_version >= 1) NOT VALID;
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS profile_change_requests (
     id serial PRIMARY KEY,
     requester_id integer NOT NULL REFERENCES users(id),
     base_profile_version integer NOT NULL CHECK (base_profile_version >= 1),
     before_values jsonb NOT NULL,
     requested_changes jsonb NOT NULL,
     reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
     status varchar(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
     decided_by integer REFERENCES users(id), decided_at timestamptz, rejection_reason text,
     applied_profile_version integer,
     created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
     deleted_at timestamptz, deleted_by integer REFERENCES users(id),
     CONSTRAINT profile_change_requested_keys_check CHECK (
       jsonb_typeof(requested_changes) = 'object' AND requested_changes <> '{}'::jsonb
       AND requested_changes - ARRAY['name','phone','countryCode','timeZone'] = '{}'::jsonb
     ),
     CONSTRAINT profile_change_decision_check CHECK (
       (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL
         AND rejection_reason IS NULL AND applied_profile_version IS NULL)
       OR (status = 'approved' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
         AND rejection_reason IS NULL AND applied_profile_version = base_profile_version + 1)
       OR (status = 'rejected' AND decided_by IS NOT NULL AND decided_at IS NOT NULL
         AND char_length(btrim(rejection_reason)) BETWEEN 5 AND 500 AND applied_profile_version IS NULL)
     ),
     CONSTRAINT profile_change_no_self_decision_check CHECK (decided_by IS NULL OR decided_by <> requester_id)
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_profile_change_requests_pending_requester
     ON profile_change_requests (requester_id) WHERE status = 'pending' AND deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_profile_change_requests_status
     ON profile_change_requests (status) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_profile_change_requests_requester_id_desc
     ON profile_change_requests (requester_id, id DESC) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_profile_change_requests_decided_by
     ON profile_change_requests (decided_by) WHERE deleted_at IS NULL`,
];
