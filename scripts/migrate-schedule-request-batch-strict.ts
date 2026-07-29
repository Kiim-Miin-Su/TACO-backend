import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEDULE_REQUEST_BATCH_STRICT_CONSTRAINT,
  SCHEDULE_REQUEST_BATCH_STRICT_MIGRATION_ID,
  SCHEDULE_REQUEST_BATCH_STRICT_PREFLIGHT_SQL,
  SCHEDULE_REQUEST_BATCH_STRICT_SQL,
} from '../src/database/migrations/schedule-request-batch-strict.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

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
    `SELECT convalidated, pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint
      WHERE conrelid='public.schedule_requests'::regclass AND conname=$1`,
    [SCHEDULE_REQUEST_BATCH_STRICT_CONSTRAINT],
  );
  const [ledger] = await executor.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [SCHEDULE_REQUEST_BATCH_STRICT_MIGRATION_ID],
  );
  const definition = String(constraint?.definition ?? '');
  return {
    constraintValidated: constraint?.convalidated === true,
    strictNullChecks: definition.includes('batch_fingerprint IS NOT NULL')
      && definition.includes('batch_index IS NOT NULL'),
    ledgerApplied: ledger?.applied === true,
  };
}

function complete(value: Awaited<ReturnType<typeof state>>): boolean {
  return value.constraintValidated && value.strictNullChecks;
}

async function main(): Promise<void> {
  await dataSource.initialize();
  await dataSource.query(SCHEDULE_REQUEST_BATCH_STRICT_PREFLIGHT_SQL);
  const before = await state();
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SCHEDULE_REQUEST_BATCH_STRICT_MIGRATION_ID,
      current: before,
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [78, 3]);
    const current = await state(manager);
    if (!complete(current)) {
      for (const sql of SCHEDULE_REQUEST_BATCH_STRICT_SQL) await manager.query(sql);
    }
    const verified = await state(manager);
    if (!complete(verified)) throw new Error('strict schedule request batch constraint is incomplete');
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [SCHEDULE_REQUEST_BATCH_STRICT_MIGRATION_ID],
    );
  });

  const after = await state();
  if (!complete(after) || !after.ledgerApplied) {
    throw new Error('strict schedule request batch migration readback failed');
  }
  console.log(JSON.stringify({
    ok: true,
    migration: SCHEDULE_REQUEST_BATCH_STRICT_MIGRATION_ID,
    after,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
