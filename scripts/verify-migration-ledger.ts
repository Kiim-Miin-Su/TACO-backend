import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { TBO29_AUTH_MIGRATION_ID } from '../src/database/migrations/tbo29-auth.migration';
import { PROFILE_CHANGE_REQUESTS_MIGRATION_ID } from '../src/database/migrations/profile-change-requests.migration';
import { PROFILE_VERIFICATION_CHALLENGES_MIGRATION_ID } from '../src/database/migrations/profile-verification-challenges.migration';
import { CLASS_SESSION_SERIES_MIGRATION_ID } from '../src/database/migrations/class-session-series.migration';
import { CREDENTIAL_RECOVERY_MIGRATION_ID } from '../src/database/migrations/credential-recovery.migration';
import { SENS_PROVIDER_MIGRATION_ID } from '../src/database/migrations/sens-provider.migration';
import { PARENTS_MIGRATION_ID } from '../src/database/migrations/parents.migration';
import { ACADEMY_EVENTS_MIGRATION_ID } from '../src/database/migrations/academy-events.migration';
import { COUNTRIES_MIGRATION_ID } from '../src/database/migrations/countries.migration';
import { SIGNUP_PROFILE_FIELDS_MIGRATION_ID } from '../src/database/migrations/signup-profile-fields.migration';
import { PROFILE_SELF_DECISION_MIGRATION_ID } from '../src/database/migrations/profile-self-decision.migration';
import { WEBID_APPROVAL_MIGRATION_ID } from '../src/database/migrations/webid-approval.migration';
import { CREDENTIAL_OTP_MIGRATION_ID } from '../src/database/migrations/credential-otp.migration';
import { COUNSEL_PERSISTENCE_MIGRATION_ID } from '../src/database/migrations/counsel-persistence.migration';
import { AUTH_RATE_LIMITS_MIGRATION_ID } from '../src/database/migrations/auth-rate-limits.migration';
import { REMAINING_PERSISTENCE_MIGRATION_ID } from '../src/database/migrations/remaining-persistence.migration';
import { COUNSEL_FORM_INPUTS_MIGRATION_ID } from '../src/database/migrations/counsel-form-inputs.migration';
import { COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID } from '../src/database/migrations/counsel-round-snapshots.migration';
import { STUDENT_PROFILE_MIGRATION_ID } from '../src/database/migrations/student-profile.migration';
import { STAFF_PAY_CALENDAR_MIGRATION_ID } from '../src/database/migrations/staff-pay-calendar.migration';

loadLocalEnv();

export const EXPECTED_MIGRATION_IDS = [
  TBO29_AUTH_MIGRATION_ID,
  PROFILE_CHANGE_REQUESTS_MIGRATION_ID,
  PROFILE_VERIFICATION_CHALLENGES_MIGRATION_ID,
  CLASS_SESSION_SERIES_MIGRATION_ID,
  CREDENTIAL_RECOVERY_MIGRATION_ID,
  SENS_PROVIDER_MIGRATION_ID,
  PARENTS_MIGRATION_ID,
  ACADEMY_EVENTS_MIGRATION_ID,
  COUNTRIES_MIGRATION_ID,
  SIGNUP_PROFILE_FIELDS_MIGRATION_ID,
  PROFILE_SELF_DECISION_MIGRATION_ID,
  WEBID_APPROVAL_MIGRATION_ID,
  CREDENTIAL_OTP_MIGRATION_ID,
  COUNSEL_PERSISTENCE_MIGRATION_ID,
  AUTH_RATE_LIMITS_MIGRATION_ID,
  REMAINING_PERSISTENCE_MIGRATION_ID,
  COUNSEL_FORM_INPUTS_MIGRATION_ID,
  COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID,
  STUDENT_PROFILE_MIGRATION_ID,
  STAFF_PAY_CALENDAR_MIGRATION_ID,
] as const;

const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function main(): Promise<void> {
  await dataSource.initialize();
  const exists = await dataSource.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
  const applied = exists[0]?.exists
    ? (await dataSource.query('SELECT id, applied_at FROM schema_migrations ORDER BY id ASC')) as Array<{ id: string; applied_at: Date }>
    : [];
  const appliedIds = new Set(applied.map((row) => row.id));
  const missing = EXPECTED_MIGRATION_IDS.filter((id) => !appliedIds.has(id));
  console.log(JSON.stringify({
    ok: missing.length === 0,
    expectedCount: EXPECTED_MIGRATION_IDS.length,
    appliedExpectedCount: EXPECTED_MIGRATION_IDS.length - missing.length,
    missing,
    applied,
  }, null, 2));
  if (missing.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
