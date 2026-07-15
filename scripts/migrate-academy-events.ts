import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { ACADEMY_EVENTS_MIGRATION_ID, ACADEMY_EVENTS_MIGRATION_SQL } from '../src/database/migrations/academy-events.migration';

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
  SELECT to_regclass('public.academy_events') IS NOT NULL AS academy_events,
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname='academy_events_range_check') AS range_check,
         EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_academy_events_range') AS range_index`;

async function main(): Promise<void> {
  await dataSource.initialize();
  const [current] = await dataSource.query(STATE_SQL);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: ACADEMY_EVENTS_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 8]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [ACADEMY_EVENTS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of ACADEMY_EVENTS_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [ACADEMY_EVENTS_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(STATE_SQL);
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [ACADEMY_EVENTS_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: ACADEMY_EVENTS_MIGRATION_ID, after: { ...after, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
