import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
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
import { STUDENT_REQUIRED_CONTRACT_MIGRATION_ID } from '../src/database/migrations/student-required-contract.migration';
import { COURSE_PAY_SSOT_MIGRATION_ID } from '../src/database/migrations/course-pay-ssot.migration';
import { COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID } from '../src/database/migrations/counsel-family-academic-expand.migration';
import { COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID } from '../src/database/migrations/counsel-student-ssot-contract.migration';
import { SCHEDULE_REQUEST_MEMO_MIGRATION_ID } from '../src/database/migrations/schedule-request-memo.migration';
import { ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID } from '../src/database/migrations/enrollment-course-unique.migration';
import { PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID } from '../src/database/migrations/payments-money-constraints.migration';
import { SIGNUP_PHONE_CHALLENGES_MIGRATION_ID } from '../src/database/migrations/signup-phone-challenges.migration';
import { VIEW_PRESET_OWNER_MIGRATION_ID } from '../src/database/migrations/view-preset-owner.migration';
import { ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID } from '../src/database/migrations/attendance-reports-constraints.migration';
import { COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID } from '../src/database/migrations/counsel-next-contact-datetime.migration';
import { SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID } from '../src/database/migrations/session-report-progress-page.migration';
import { AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID } from '../src/database/migrations/auth-refresh-token-integrity.migration';
import { INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID } from '../src/database/migrations/instructor-contract-integrity.migration';
import { INSTRUCTOR_CONTRACT_BOUNDS_MIGRATION_ID } from '../src/database/migrations/instructor-contract-bounds.migration';

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
  STUDENT_REQUIRED_CONTRACT_MIGRATION_ID,
  COURSE_PAY_SSOT_MIGRATION_ID,
  COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID,
  COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID,
  SCHEDULE_REQUEST_MEMO_MIGRATION_ID,
  ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID,
  PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID, // [TBO-53 C1] payments/transactions FK·CHECK
  SIGNUP_PHONE_CHALLENGES_MIGRATION_ID, // [TBO-57] 가입 전 휴대전화 OTP challenge 표
  VIEW_PRESET_OWNER_MIGRATION_ID, // [TBO-58 P2] calendar_view_presets 소유자 FK
  ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID, // [74D-1] attendance/session_reports FK 7·CHECK 3·역방향 index
  COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID, // [76A-1] counsel next_contact_at date→timestamptz
  SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID, // [76D] session report authored progress page
  AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID, // [76H] refresh token user/replacement FK + self/expiry CHECK
  INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID, // [77C] contract FK/value/active-period exclusion
  INSTRUCTOR_CONTRACT_BOUNDS_MIGRATION_ID, // [77C] DTO max bounds mirrored in DB CHECK
] as const;

const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function main(): Promise<void> {
  await dataSource.initialize();
  const exists = await dataSource.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists");
  const applied = exists[0]?.exists
    ? (await dataSource.query('SELECT id, applied_at FROM schema_migrations ORDER BY id ASC')) as Array<{ id: string; applied_at: Date }>
    : [];
  const appliedIds = new Set(applied.map((row) => row.id));
  const expectedIds = new Set<string>(EXPECTED_MIGRATION_IDS);
  const missing = EXPECTED_MIGRATION_IDS.filter((id) => !appliedIds.has(id));
  const unexpected = applied.map((row) => row.id).filter((id) => !expectedIds.has(id));
  console.log(JSON.stringify({
    ok: missing.length === 0 && unexpected.length === 0,
    expectedCount: EXPECTED_MIGRATION_IDS.length,
    appliedExpectedCount: EXPECTED_MIGRATION_IDS.length - missing.length,
    missing,
    unexpected,
    applied,
  }, null, 2));
  if (missing.length || unexpected.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
