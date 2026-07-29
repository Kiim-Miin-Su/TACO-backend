import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  AUTH_EVENT_DOMAIN_CONSTRAINT,
  AUTH_EVENT_DOMAIN_MIGRATION_ID,
  AUTH_EVENT_DOMAIN_SQL,
} from '../src/database/migrations/auth-event-domain.migration';

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

async function state(executor: Pick<DataSource, 'query'> = dataSource) {
  const [constraint] = await executor.query(
    `SELECT convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid='public.auth_events'::regclass AND conname=$1`,
    [AUTH_EVENT_DOMAIN_CONSTRAINT],
  );
  const [ledger] = await executor.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [AUTH_EVENT_DOMAIN_MIGRATION_ID],
  );
  return {
    validated: constraint?.convalidated === true,
    includesRecoverCompleted: String(constraint?.definition ?? '').includes('recover_id_completed'),
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>): boolean =>
  value.validated && value.includesRecoverCompleted;

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    const before = await state();
    await dataSource.transaction(async (manager) => {
      for (const sql of AUTH_EVENT_DOMAIN_SQL) await manager.query(sql);
      if (!complete(await state(manager))) throw new Error('auth event domain dry-run failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: AUTH_EVENT_DOMAIN_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(await state()),
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [78, 5]);
    if (!complete(await state(manager))) {
      for (const sql of AUTH_EVENT_DOMAIN_SQL) await manager.query(sql);
    }
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [AUTH_EVENT_DOMAIN_MIGRATION_ID],
    );
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) throw new Error('auth event domain migration readback failed');
  console.log(JSON.stringify({ ok: true, migration: AUTH_EVENT_DOMAIN_MIGRATION_ID, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
