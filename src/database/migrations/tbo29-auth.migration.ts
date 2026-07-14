export const TBO29_AUTH_MIGRATION_ID = '20260714_01_tbo29_auth';

export const TBO29_AUTH_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone varchar(20)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_hash varchar(64)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires_at timestamptz`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_by integer`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at timestamptz`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code varchar(8)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS time_zone varchar(64)`,
  `ALTER TABLE users DROP COLUMN IF EXISTS email_verify_token`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
       ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','admin','manager','instructor')) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check') THEN
       ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending','active','rejected')) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_approved_by_fkey') THEN
       ALTER TABLE users ADD CONSTRAINT users_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES users(id) NOT VALID;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM users WHERE deleted_at IS NULL GROUP BY lower(web_id) HAVING count(*) > 1
     ) THEN RAISE EXCEPTION 'active case-insensitive web_id duplicates must be resolved before migration'; END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_users_active_web_id_ci ON users (lower(web_id)) WHERE deleted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS instructor_profiles (
     user_id integer PRIMARY KEY REFERENCES users(id),
     active boolean NOT NULL DEFAULT true,
     approved_by integer NOT NULL REFERENCES users(id),
     approved_at timestamptz NOT NULL,
     university varchar(100), major varchar(100), birth_year integer,
     created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
     deleted_at timestamptz, deleted_by integer REFERENCES users(id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_instructor_profiles_active ON instructor_profiles (active, user_id) WHERE deleted_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS auth_events (
     id serial PRIMARY KEY,
     event_type varchar(32) NOT NULL CHECK (event_type IN ('login_success','login_failure','logout')),
     user_id integer REFERENCES users(id), attempted_web_id_hash varchar(64), request_id varchar(64),
     ip_hash varchar(64), user_agent varchar(300), success boolean NOT NULL, failure_code varchar(40),
     at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_events_user_at ON auth_events (user_id, at)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_events_type_at ON auth_events (event_type, at)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_events_request_id ON auth_events (request_id)`,
];
