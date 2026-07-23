import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  REMAINING_PERSISTENCE_MIGRATION_ID,
  REMAINING_PERSISTENCE_MIGRATION_SQL,
} from '../src/database/migrations/remaining-persistence.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const STATE_SQL = `
  SELECT to_regclass('public.roadmaps') IS NOT NULL AS roadmaps,
         to_regclass('public.roadmap_courses') IS NOT NULL AS roadmap_courses,
         to_regclass('public.report_templates') IS NOT NULL AS report_templates,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='class_sessions' AND column_name='is_paid') AS is_paid,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='class_sessions' AND column_name='paid_payout_id') AS paid_payout_id`;

async function main(): Promise<void> {
  await dataSource.initialize();
  const [current] = await dataSource.query(STATE_SQL);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: REMAINING_PERSISTENCE_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [34, 2]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [REMAINING_PERSISTENCE_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of REMAINING_PERSISTENCE_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [REMAINING_PERSISTENCE_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(STATE_SQL);
  const [ledger] = await dataSource.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [REMAINING_PERSISTENCE_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: REMAINING_PERSISTENCE_MIGRATION_ID, after: { ...ledger, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
