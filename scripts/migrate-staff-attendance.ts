import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  STAFF_ATTENDANCE_MIGRATION_ID,
  STAFF_ATTENDANCE_MIGRATION_SQL,
} from '../src/database/migrations/staff-attendance.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('A direct database URL is required');

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

type Executor = { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };

async function state(executor: Executor = dataSource) {
  const [table] = await executor.query(
    `SELECT to_regclass('public.staff_attendance_records') IS NOT NULL AS exists`,
  ) as Array<{ exists: boolean }>;
  if (!table?.exists) return { exists: false, constraints: 0, indexes: 0, ledgerApplied: false };
  const [constraints] = await executor.query(
    `SELECT count(*)::int AS count
       FROM pg_constraint
      WHERE conrelid='public.staff_attendance_records'::regclass
        AND conname IN ('c_staff_attendance_status','c_staff_attendance_time_pair','c_staff_attendance_work_window')
        AND convalidated`,
  ) as Array<{ count: number }>;
  const [indexes] = await executor.query(
    `SELECT count(*)::int AS count
       FROM pg_index i
       JOIN pg_class c ON c.oid=i.indexrelid
      WHERE i.indrelid='public.staff_attendance_records'::regclass
        AND c.relname IN (
          'uq_staff_attendance_staff_date_active',
          'idx_staff_attendance_date_staff_active',
          'idx_staff_attendance_staff_date_active'
        )
        AND i.indisvalid AND i.indisready`,
  ) as Array<{ count: number }>;
  const [ledger] = await executor.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [STAFF_ATTENDANCE_MIGRATION_ID],
  ) as Array<{ applied: boolean }>;
  return {
    exists: true,
    constraints: Number(constraints?.count ?? 0),
    indexes: Number(indexes?.count ?? 0),
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>): boolean =>
  value.exists && value.constraints === 3 && value.indexes === 3;

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    const before = await state();
    await dataSource.transaction(async (manager) => {
      for (const sql of STAFF_ATTENDANCE_MIGRATION_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('staff attendance dry-run verification failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: STAFF_ATTENDANCE_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(await state()),
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [81, 1]);
    if (!complete(await state(manager))) {
      for (const sql of STAFF_ATTENDANCE_MIGRATION_SQL) await manager.query(sql);
    }
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [STAFF_ATTENDANCE_MIGRATION_ID],
    );
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) throw new Error('staff attendance migration readback failed');
  console.log(JSON.stringify({ ok: true, migration: STAFF_ATTENDANCE_MIGRATION_ID, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
