import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  COUNSEL_FORM_INPUTS_MIGRATION_ID,
  COUNSEL_FORM_INPUTS_MIGRATION_SQL,
} from '../src/database/migrations/counsel-form-inputs.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const stateSql = `SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='counsel_forms' AND column_name='submitter_type'
  ) AS submitter_type,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='counsel_forms' AND column_name='submitter_type'
      AND is_nullable='NO' AND column_default LIKE '%unknown%'
  ) AS not_null_default_unknown,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.counsel_forms'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%submitter_type%parent%student%staff%unknown%'
  ) AS enum_check`;

async function main(): Promise<void> {
  await dataSource.initialize();
  const [current] = await dataSource.query(stateSql);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: COUNSEL_FORM_INPUTS_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [34, 3]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [COUNSEL_FORM_INPUTS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of COUNSEL_FORM_INPUTS_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [COUNSEL_FORM_INPUTS_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(stateSql);
  const [ledger] = await dataSource.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [COUNSEL_FORM_INPUTS_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: COUNSEL_FORM_INPUTS_MIGRATION_ID, after: { ...ledger, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
