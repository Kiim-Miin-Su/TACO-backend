import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { COUNTRIES_MIGRATION_ID, COUNTRIES_MIGRATION_SQL } from '../src/database/migrations/countries.migration';

// [E0.5 ④] 국가·시간대 카탈로그 마이그레이션 — dry-run 기본, APPLY=1일 때만 적용(멱등).
loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const STATE_SQL = `
  SELECT to_regclass('public.countries') IS NOT NULL AS countries,
         (SELECT COUNT(*) FROM countries WHERE deleted_at IS NULL) AS active_rows`;
const STATE_SQL_NO_TABLE = `SELECT to_regclass('public.countries') IS NOT NULL AS countries, 0 AS active_rows`;

async function state(): Promise<Record<string, unknown>> {
  const [exists] = await dataSource.query(`SELECT to_regclass('public.countries') IS NOT NULL AS ok`);
  const [row] = await dataSource.query(exists?.ok ? STATE_SQL : STATE_SQL_NO_TABLE);
  return row;
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: COUNTRIES_MIGRATION_ID, current: await state() }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 10]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [COUNTRIES_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of COUNTRIES_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [COUNTRIES_MIGRATION_ID]);
  });
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [COUNTRIES_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: COUNTRIES_MIGRATION_ID, after: { ...after, ...(await state()) } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
