import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID,
  COUNSEL_ROUND_SNAPSHOTS_MIGRATION_SQL,
} from '../src/database/migrations/counsel-round-snapshots.migration';

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
  const [column] = await dataSource.query(`SELECT
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='counsel_rounds' AND column_name='form_snapshot'
    ) AS form_snapshot,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='counsel_rounds' AND column_name='form_snapshot'
        AND data_type='jsonb' AND is_nullable='NO'
    ) AS jsonb_not_null,
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid='public.counsel_rounds'::regclass
        AND pg_get_constraintdef(oid) LIKE '%jsonb_typeof(form_snapshot)%object%'
    ) AS object_check`);
  if (!column.form_snapshot) return column;
  const [rows] = await dataSource.query(`SELECT
    COUNT(*)::int AS total_rounds,
    COUNT(*) FILTER (WHERE form_snapshot IS NULL OR form_snapshot = '{}'::jsonb)::int AS missing_snapshots
    FROM counsel_rounds`);
  return { ...column, ...rows };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const current = await state();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [34, 4]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of COUNSEL_ROUND_SNAPSHOTS_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID]);
  });
  const [ledger] = await dataSource.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID, after: { ...ledger, ...(await state()) } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
