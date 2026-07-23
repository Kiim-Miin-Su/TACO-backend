import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  STAFF_PAY_CALENDAR_MIGRATION_ID,
  STAFF_PAY_CALENDAR_MIGRATION_SQL,
} from '../src/database/migrations/staff-pay-calendar.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function state(): Promise<Record<string, unknown>> {
  const [columns] = await dataSource.query(`SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='instructor_profiles' AND column_name='default_hourly_rate') AS instructor_default_hourly_rate,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='instructor_profiles' AND column_name='can_teach_kinder') AS instructor_can_teach_kinder,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='hourly_rate_override') AS course_hourly_rate_override,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='is_kinder') AS course_is_kinder,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='class_sessions' AND column_name='is_public') AS session_is_public`);
  const [students] = await dataSource.query(`SELECT
    COUNT(*) FILTER (WHERE deleted_at IS NULL AND birth_date IS NULL)::int AS missing_birth_date,
    COUNT(*) FILTER (WHERE deleted_at IS NULL AND grade IS NULL)::int AS missing_grade,
    COUNT(*) FILTER (WHERE deleted_at IS NULL AND grade IS NOT NULL AND grade NOT BETWEEN 0 AND 12)::int AS invalid_grade
    FROM students`);
  const courseRateConflicts = await dataSource.query(`SELECT instructor_id,
      COUNT(*)::int AS course_count,
      COUNT(DISTINCT hourly_rate)::int AS distinct_rates,
      ARRAY_AGG(DISTINCT hourly_rate ORDER BY hourly_rate) AS rates
    FROM courses
    WHERE deleted_at IS NULL AND instructor_id IS NOT NULL
    GROUP BY instructor_id
    HAVING COUNT(DISTINCT hourly_rate) > 1
    ORDER BY instructor_id`);
  return { ...columns, students, courseRateConflicts };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const current = await state();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: STAFF_PAY_CALENDAR_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [36, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [STAFF_PAY_CALENDAR_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of STAFF_PAY_CALENDAR_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [STAFF_PAY_CALENDAR_MIGRATION_ID]);
  });
  const [ledger] = await dataSource.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [STAFF_PAY_CALENDAR_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: STAFF_PAY_CALENDAR_MIGRATION_ID, after: { ...ledger, ...(await state()) } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
