import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  STUDENT_PROFILE_MIGRATION_ID,
  STUDENT_PROFILE_MIGRATION_SQL,
} from '../src/database/migrations/student-profile.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function state(): Promise<Record<string, unknown>> {
  const [shape] = await dataSource.query(`SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='gender') AS gender,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='birth_date' AND data_type='date') AS birth_date,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='kakao_id') AS kakao_id,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='counsel_topic') AS counsel_topic,
    to_regclass('public.student_interests') IS NOT NULL AS student_interests`);
  const statusCounts = await dataSource.query(
    `SELECT status, COUNT(*)::int AS count FROM students GROUP BY status ORDER BY status`,
  );
  if (!shape.student_interests) return { ...shape, statusCounts };
  const [integrity] = await dataSource.query(`SELECT
    COUNT(*)::int AS total_interests,
    COUNT(*) FILTER (WHERE priority <= 0)::int AS invalid_priority,
    COUNT(*) FILTER (WHERE (course_id IS NOT NULL) = (NULLIF(BTRIM(custom_label), '') IS NOT NULL))::int AS invalid_target
    FROM student_interests WHERE deleted_at IS NULL`);
  const constraints = await dataSource.query(`SELECT conname
    FROM pg_constraint
    WHERE conrelid IN ('public.students'::regclass, 'public.student_interests'::regclass)
    ORDER BY conname`);
  return { ...shape, statusCounts, ...integrity, constraints: constraints.map((row: { conname: string }) => row.conname) };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const current = await state();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: STUDENT_PROFILE_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [35, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [STUDENT_PROFILE_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of STUDENT_PROFILE_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [STUDENT_PROFILE_MIGRATION_ID]);
  });
  const [ledger] = await dataSource.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [STUDENT_PROFILE_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: STUDENT_PROFILE_MIGRATION_ID, after: { ...ledger, ...(await state()) } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
