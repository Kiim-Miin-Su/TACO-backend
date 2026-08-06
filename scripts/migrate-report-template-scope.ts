import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  REPORT_TEMPLATE_SCOPE_CONSTRAINT,
  REPORT_TEMPLATE_SCOPE_INDEXES,
  REPORT_TEMPLATE_SCOPE_MIGRATION_ID,
  REPORT_TEMPLATE_SCOPE_MIGRATION_SQL,
} from '../src/database/migrations/report-template-scope.migration';

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
  const columns = await executor.query(
    `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='report_templates'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [['progress_page', 'owner_user_id', 'is_default', 'is_enforced']],
  ) as Array<{ column_name: string; is_nullable: string; column_default: string | null }>;
  const constraints = await executor.query(
    `SELECT conname, convalidated
       FROM pg_constraint
      WHERE conrelid='public.report_templates'::regclass
        AND conname = ANY($1::text[])
      ORDER BY conname`,
    [['fk_report_templates_owner_user', REPORT_TEMPLATE_SCOPE_CONSTRAINT]],
  ) as Array<{ conname: string; convalidated: boolean }>;
  const indexes = await executor.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND tablename='report_templates'
        AND indexname = ANY($1::text[])
      ORDER BY indexname`,
    [[...REPORT_TEMPLATE_SCOPE_INDEXES]],
  ) as Array<{ indexname: string }>;
  const [invalid] = columns.length === 4
    ? await executor.query(
      `SELECT
         count(*) FILTER (WHERE owner_user_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM instructor_profiles profile WHERE profile.user_id=report_templates.owner_user_id
         ))::int AS invalid_owner,
         count(*) FILTER (WHERE is_enforced AND owner_user_id IS NOT NULL)::int AS invalid_enforced
         FROM report_templates WHERE deleted_at IS NULL`,
    ) as Array<{ invalid_owner: number; invalid_enforced: number }>
    : [{ invalid_owner: -1, invalid_enforced: -1 }];
  const [duplicates] = columns.length === 4
    ? await executor.query(
      `SELECT
         (SELECT count(*)::int FROM (
            SELECT COALESCE(owner_user_id, 0), name FROM report_templates
             WHERE deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1
          ) rows) AS duplicate_names,
         (SELECT count(*)::int FROM (
            SELECT COALESCE(owner_user_id, 0) FROM report_templates
             WHERE deleted_at IS NULL AND is_default GROUP BY 1 HAVING count(*) > 1
          ) rows) AS duplicate_defaults,
         (SELECT GREATEST(count(*) - 1, 0)::int FROM report_templates
           WHERE deleted_at IS NULL AND owner_user_id IS NULL AND is_enforced) AS duplicate_enforced`,
    ) as Array<{ duplicate_names: number; duplicate_defaults: number; duplicate_enforced: number }>
    : [{ duplicate_names: -1, duplicate_defaults: -1, duplicate_enforced: -1 }];
  const [ledgerTable] = await executor.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  ) as Array<{ present: boolean }>;
  const [ledger] = ledgerTable?.present
    ? await executor.query(`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [REPORT_TEMPLATE_SCOPE_MIGRATION_ID]) as Array<{ applied: boolean }>
    : [{ applied: false }];
  return {
    columns,
    constraints,
    indexes: indexes.map((row) => row.indexname),
    invalidOwnerCount: invalid?.invalid_owner ?? -1,
    invalidEnforcedCount: invalid?.invalid_enforced ?? -1,
    duplicateNameScopes: duplicates?.duplicate_names ?? -1,
    duplicateDefaultScopes: duplicates?.duplicate_defaults ?? -1,
    duplicateGlobalEnforced: duplicates?.duplicate_enforced ?? -1,
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>) =>
  value.columns.length === 4
  && value.constraints.length === 2
  && value.constraints.every((constraint) => constraint.convalidated)
  && value.indexes.length === REPORT_TEMPLATE_SCOPE_INDEXES.length
  && value.invalidOwnerCount === 0
  && value.invalidEnforcedCount === 0
  && value.duplicateNameScopes === 0
  && value.duplicateDefaultScopes === 0
  && value.duplicateGlobalEnforced === 0;

async function main() {
  await dataSource.initialize();
  const before = await state();
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 5]);
      for (const sql of REPORT_TEMPLATE_SCOPE_MIGRATION_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('report template scope dry-run readback failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await state();
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: REPORT_TEMPLATE_SCOPE_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback),
    }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 5]);
    if (!complete(await state(manager))) {
      for (const sql of REPORT_TEMPLATE_SCOPE_MIGRATION_SQL) await manager.query(sql);
    }
    if (!complete(await state(manager))) throw new Error('report template scope migration readback failed');
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [REPORT_TEMPLATE_SCOPE_MIGRATION_ID],
    );
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) throw new Error('report template scope ledger/readback failed');
  console.log(JSON.stringify({ ok: true, migration: REPORT_TEMPLATE_SCOPE_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
