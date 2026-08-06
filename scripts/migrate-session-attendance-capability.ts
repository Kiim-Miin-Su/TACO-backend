import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ROLE_CAPABILITIES } from '@kms545487/contracts';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SESSION_ATTENDANCE_CAPABILITY_MIGRATION_ID,
  SESSION_ATTENDANCE_CAPABILITY_MIGRATION_SQL,
} from '../src/database/migrations/session-attendance-capability.migration';

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
const expectedDomain = [...ROLE_CAPABILITIES].sort();

function constraintDomain(definition: string): string[] {
  return [...definition.matchAll(/'([^']+)'::/g)].map((match) => match[1]).sort();
}

async function state(executor: Executor = dataSource) {
  const [constraint] = await executor.query(
    `SELECT convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid='public.user_capability_overrides'::regclass
        AND conname='c_user_capability_overrides_capability'`,
  ) as Array<{ convalidated: boolean; definition: string }>;
  const invalidRows = await executor.query(
    `SELECT capability, count(*)::int AS count
       FROM user_capability_overrides
      WHERE capability <> ALL($1::text[])
      GROUP BY capability
      ORDER BY capability`,
    [expectedDomain],
  );
  const [ledger] = await executor.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [SESSION_ATTENDANCE_CAPABILITY_MIGRATION_ID],
  ) as Array<{ applied: boolean }>;
  return {
    validated: constraint?.convalidated === true,
    domain: constraint ? constraintDomain(constraint.definition) : [],
    invalidRows,
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>): boolean =>
  value.validated
  && JSON.stringify(value.domain) === JSON.stringify(expectedDomain)
  && value.invalidRows.length === 0;

async function main(): Promise<void> {
  await dataSource.initialize();
  const before = await state();
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 1]);
      for (const sql of SESSION_ATTENDANCE_CAPABILITY_MIGRATION_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('session attendance capability dry-run readback failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await state();
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SESSION_ATTENDANCE_CAPABILITY_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback),
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 1]);
    if (!complete(await state(manager))) {
      for (const sql of SESSION_ATTENDANCE_CAPABILITY_MIGRATION_SQL) await manager.query(sql);
    }
    if (!complete(await state(manager))) throw new Error('session attendance capability migration readback failed');
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [SESSION_ATTENDANCE_CAPABILITY_MIGRATION_ID],
    );
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) {
    throw new Error('session attendance capability migration ledger/readback failed');
  }
  console.log(JSON.stringify({ ok: true, migration: SESSION_ATTENDANCE_CAPABILITY_MIGRATION_ID, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
