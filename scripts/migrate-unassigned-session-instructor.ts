import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_ID,
  UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_SQL,
} from '../src/database/migrations/unassigned-session-instructor.migration';

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
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema='public' AND table_name='class_sessions' AND column_name='instructor_id'`,
  ) as Array<{ is_nullable: string }>;
  const constraints = await executor.query(
    `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid='public.class_sessions'::regclass
        AND conname = ANY($1::text[])
      ORDER BY conname`,
    [['c_class_sessions_unassigned_instructor_state', 'fk_class_sessions_instructor']],
  ) as Array<{ conname: string; convalidated: boolean; definition: string }>;
  const [invalid] = await executor.query(
    `SELECT count(*)::int AS count FROM class_sessions
      WHERE instructor_id IS NULL AND NOT (
        status NOT IN ('held','makeup') AND instructor_attendance IS NULL
        AND instructor_pay_amount IS NULL AND payout_id IS NULL
        AND paid_payout_id IS NULL AND is_paid=false
      )`,
  ) as Array<{ count: number }>;
  const indexes = await executor.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname = ANY($1::text[]) ORDER BY indexname`,
    [['idx_sessions_assigned_instructor_date', 'idx_sessions_unassigned_date']],
  ) as Array<{ indexname: string }>;
  const [ledgerTable] = await executor.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
  ) as Array<{ exists: boolean }>;
  const [ledger] = ledgerTable?.exists
    ? await executor.query(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`,
      [UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_ID],
    ) as Array<{ applied: boolean }>
    : [{ applied: false }];
  return { nullable: column?.is_nullable === 'YES', constraints, invalidCount: invalid?.count ?? -1,
    indexes: indexes.map((row) => row.indexname), ledgerApplied: ledger?.applied === true };
}

const complete = (value: Awaited<ReturnType<typeof state>>) =>
  value.nullable && value.invalidCount === 0 && value.constraints.length === 2
  && value.constraints.every((row) => row.convalidated)
  && value.constraints.find((row) => row.conname === 'fk_class_sessions_instructor')?.definition.includes('ON DELETE RESTRICT') === true
  && value.indexes.length === 2;

async function main() {
  await dataSource.initialize();
  const before = await state();
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 2]);
      for (const sql of UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('unassigned instructor dry-run readback failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await state();
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_ID,
      before, rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback) }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 2]);
    if (!complete(await state(manager))) {
      for (const sql of UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_SQL) await manager.query(sql);
    }
    if (!complete(await state(manager))) throw new Error('unassigned instructor migration readback failed');
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_ID]);
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) throw new Error('unassigned instructor migration ledger/readback failed');
  console.log(JSON.stringify({ ok: true, migration: UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
