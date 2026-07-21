import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  STUDENT_REQUIRED_CONTRACT_MIGRATION_ID,
  STUDENT_REQUIRED_CONTRACT_SQL,
} from '../src/database/migrations/student-required-contract.migration';

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
  const [columns] = await dataSource.query(`SELECT
    (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='grade') AS grade_nullable,
    (SELECT is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='students' AND column_name='birth_date') AS birth_date_nullable`);
  const constraints = await dataSource.query(`SELECT conname, convalidated
    FROM pg_constraint WHERE conrelid='public.students'::regclass
      AND conname IN ('students_grade_check','students_birth_date_required') ORDER BY conname`);
  const [invalid] = await dataSource.query(`SELECT
    COUNT(*) FILTER (WHERE grade IS NULL OR grade NOT BETWEEN 0 AND 12)::int AS invalid_grade,
    COUNT(*) FILTER (WHERE birth_date IS NULL)::int AS missing_birth_date
    FROM students WHERE deleted_at IS NULL`);
  return { ...columns, ...invalid, constraints };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const current = await state();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: STUDENT_REQUIRED_CONTRACT_MIGRATION_ID, current }, null, 2));
    return;
  }
  if (Number(current.invalid_grade) > 0 || Number(current.missing_birth_date) > 0) {
    throw new Error(`학생 필수값 정리 필요: invalid_grade=${current.invalid_grade}, missing_birth_date=${current.missing_birth_date}`);
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [36, 5]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [STUDENT_REQUIRED_CONTRACT_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of STUDENT_REQUIRED_CONTRACT_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [STUDENT_REQUIRED_CONTRACT_MIGRATION_ID]);
  });
  console.log(JSON.stringify({ ok: true, migration: STUDENT_REQUIRED_CONTRACT_MIGRATION_ID, after: await state() }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
