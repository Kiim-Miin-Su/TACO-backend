import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SESSION_REPORT_METADATA_CONSTRAINT,
  SESSION_REPORT_REVISIONS_MIGRATION_ID,
  SESSION_REPORT_REVISIONS_SQL,
} from '../src/database/migrations/session-report-revisions.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('A direct database URL is required');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false,
  entities: [], migrations: [], ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

type Executor = { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };

async function state(executor: Executor = dataSource) {
  const [column] = await executor.query(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='session_reports' AND column_name='version'`,
  ) as Array<{ is_nullable?: string; column_default?: string }>;
  const [revisionTable] = await executor.query(
    `SELECT to_regclass('public.session_report_revisions') IS NOT NULL AS present`,
  ) as Array<{ present: boolean }>;
  const [constraint] = await executor.query(
    `SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='public.session_reports'::regclass AND conname=$1`,
    [SESSION_REPORT_METADATA_CONSTRAINT],
  ) as Array<{ convalidated?: boolean; definition?: string }>;
  const indexes = revisionTable?.present
    ? await executor.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='session_report_revisions'
        AND indexname = ANY($1::text[]) ORDER BY indexname`,
      [['idx_session_report_revisions_report_created', 'uq_session_report_revisions_report_version']],
    ) as Array<{ indexname: string }>
    : [];
  const [invalid] = column
    ? await executor.query(
      `SELECT count(*)::int AS count FROM session_reports WHERE deleted_at IS NULL AND NOT (
         version > 0 AND (
           (approval_status='approved' AND approved_at IS NOT NULL AND rejected_reason IS NULL)
           OR (approval_status='rejected' AND approved_at IS NULL AND approved_by IS NULL AND length(btrim(rejected_reason)) > 0)
           OR (approval_status IN ('draft','submitted') AND approved_at IS NULL AND approved_by IS NULL AND rejected_reason IS NULL)
         )
       )`,
    ) as Array<{ count: number }>
    : [{ count: -1 }];
  const [ledgerTable] = await executor.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  ) as Array<{ present: boolean }>;
  const [ledger] = ledgerTable?.present
    ? await executor.query(`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [SESSION_REPORT_REVISIONS_MIGRATION_ID]) as Array<{ applied: boolean }>
    : [{ applied: false }];
  return {
    versionColumn: column ?? null,
    revisionTable: revisionTable?.present === true,
    metadataConstraint: constraint ?? null,
    indexes: indexes.map((row) => row.indexname),
    invalidCount: invalid?.count ?? -1,
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>) =>
  value.versionColumn?.is_nullable === 'NO'
  && value.revisionTable
  && value.metadataConstraint?.convalidated === true
  && value.indexes.length === 2
  && value.invalidCount === 0;

async function main() {
  await dataSource.initialize();
  const before = await state();
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 4]);
      for (const sql of SESSION_REPORT_REVISIONS_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('session report revision dry-run readback failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await state();
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SESSION_REPORT_REVISIONS_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback),
    }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 4]);
    if (!complete(await state(manager))) {
      for (const sql of SESSION_REPORT_REVISIONS_SQL) await manager.query(sql);
    }
    if (!complete(await state(manager))) throw new Error('session report revision migration readback failed');
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [SESSION_REPORT_REVISIONS_MIGRATION_ID],
    );
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) throw new Error('session report revision ledger/readback failed');
  console.log(JSON.stringify({ ok: true, migration: SESSION_REPORT_REVISIONS_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});

