import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  STAFF_ENGLISH_NAME_CHECK,
  STAFF_ENGLISH_NAME_EXPAND_SQL,
  STAFF_ENGLISH_NAME_MIGRATION_ID,
  STAFF_ENGLISH_NAME_MIGRATION_SQL,
} from '../src/database/migrations/staff-english-name.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const prepare = process.env.PREPARE === '1';
if (apply && prepare) throw new Error('Set only one of APPLY=1 or PREPARE=1');
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
    `SELECT EXISTS (
       SELECT 1 FROM pg_attribute
        WHERE attrelid='public.users'::regclass AND attname='english_name' AND NOT attisdropped
     ) AS present,
     COALESCE((SELECT attnotnull FROM pg_attribute
       WHERE attrelid='public.users'::regclass AND attname='english_name' AND NOT attisdropped), false) AS not_null`,
  ) as Array<{ present: boolean; not_null: boolean }>;
  const [check] = await executor.query(
    `SELECT COUNT(*)::int AS present, COUNT(*) FILTER (WHERE convalidated)::int AS validated
       FROM pg_constraint WHERE conname=$1 AND conrelid='public.users'::regclass`,
    [STAFF_ENGLISH_NAME_CHECK],
  ) as Array<{ present: number; validated: number }>;
  const [invalid] = column?.present
    ? await executor.query(
      `SELECT COUNT(*)::int AS invalid FROM users
        WHERE english_name IS NULL OR english_name<>btrim(english_name)
           OR char_length(english_name) NOT BETWEEN 1 AND 80
           OR english_name !~ '^[A-Za-z][A-Za-z .''-]*$'`,
    ) as Array<{ invalid: number }>
    : [{ invalid: -1 }];
  const [ledgerTable] = await executor.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`) as Array<{ present: boolean }>;
  const [ledger] = ledgerTable?.present
    ? await executor.query(`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [STAFF_ENGLISH_NAME_MIGRATION_ID]) as Array<{ applied: boolean }>
    : [{ applied: false }];
  return {
    columnPresent: column?.present === true,
    notNull: column?.not_null === true,
    checkPresent: check?.present === 1,
    checkValidated: check?.validated === 1,
    invalidRows: invalid?.invalid ?? -1,
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>) =>
  value.columnPresent && value.notNull && value.checkPresent && value.checkValidated && value.invalidRows === 0;
const prepared = (value: Awaited<ReturnType<typeof state>>) =>
  value.columnPresent && value.checkPresent && value.checkValidated && value.invalidRows === 0;

async function main() {
  await dataSource.initialize();
  const before = await state();
  if (prepare) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [96, 1]);
      for (const sql of STAFF_ENGLISH_NAME_EXPAND_SQL) await manager.query(sql);
      if (!prepared(await state(manager))) throw new Error('staff english name prepare readback failed');
    });
    const after = await state();
    console.log(JSON.stringify({
      ok: true, prepared: true, migration: STAFF_ENGLISH_NAME_MIGRATION_ID, before, after,
      next: 'Deploy the new backend, then rerun with APPLY=1 to enforce NOT NULL and write the ledger.',
    }, null, 2));
    return;
  }
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [96, 1]);
      for (const sql of STAFF_ENGLISH_NAME_MIGRATION_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('staff english name dry-run readback failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await state();
    console.log(JSON.stringify({
      ok: true, dryRun: true, migration: STAFF_ENGLISH_NAME_MIGRATION_ID, before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback),
    }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [96, 1]);
    if (!complete(await state(manager))) {
      for (const sql of STAFF_ENGLISH_NAME_MIGRATION_SQL) await manager.query(sql);
    }
    if (!complete(await state(manager))) throw new Error('staff english name migration readback failed');
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [STAFF_ENGLISH_NAME_MIGRATION_ID]);
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) throw new Error('staff english name ledger/readback failed');
  console.log(JSON.stringify({ ok: true, migration: STAFF_ENGLISH_NAME_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
