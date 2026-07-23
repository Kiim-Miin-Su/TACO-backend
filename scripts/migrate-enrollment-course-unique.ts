import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID,
  ENROLLMENT_COURSE_UNIQUE_MIGRATION_SQL,
} from '../src/database/migrations/enrollment-course-unique.migration';

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
  const [row] = await dataSource.query(`SELECT
    EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND tablename='enrollments'
        AND indexname='uq_enrollments_student_course_active'
    ) AS index_exists,
    (SELECT COUNT(*)::int FROM (
      SELECT student_id, course_id FROM enrollments
      WHERE deleted_at IS NULL
      GROUP BY student_id, course_id HAVING COUNT(*) > 1
    ) d) AS duplicate_groups,
    EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name='schema_migrations'
    ) AS ledger_exists`);
  let ledgerApplied = false;
  if (row.ledger_exists) {
    const [ledger] = await dataSource.query('SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied', [ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID]);
    ledgerApplied = ledger.applied === true;
  }
  return {
    indexExists: row.index_exists === true,
    duplicateGroups: Number(row.duplicate_groups),
    ledgerApplied,
  };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID, current: await state() }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [48, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of ENROLLMENT_COURSE_UNIQUE_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID]);
  });
  const after = await state();
  if (!after.indexExists || after.duplicateGroups !== 0 || !after.ledgerApplied) {
    throw new Error('enrollment course unique migration readback failed');
  }
  console.log(JSON.stringify({ ok: true, migration: ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
