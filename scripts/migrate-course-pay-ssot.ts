import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  COURSE_PAY_SSOT_MIGRATION_ID,
  COURSE_PAY_SSOT_SQL,
} from '../src/database/migrations/course-pay-ssot.migration';

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
  const [row] = await dataSource.query(`SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='hourly_rate') AS legacy_column,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='courses' AND column_name='hourly_rate_override') AS override_column,
    (SELECT COUNT(*)::int FROM courses) AS course_rows`);
  return row;
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const current = await state();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: COURSE_PAY_SSOT_MIGRATION_ID, current }, null, 2));
    return;
  }
  if (current.legacy_column && Number(current.course_rows) > 0) {
    throw new Error(`courses.hourly_rate 분류가 필요한 수업 ${current.course_rows}행이 남아 있어 DROP을 중단합니다.`);
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [36, 6]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [COURSE_PAY_SSOT_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of COURSE_PAY_SSOT_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [COURSE_PAY_SSOT_MIGRATION_ID]);
  });
  console.log(JSON.stringify({ ok: true, migration: COURSE_PAY_SSOT_MIGRATION_ID, after: await state() }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
