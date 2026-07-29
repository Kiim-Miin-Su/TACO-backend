import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEDULE_REQUEST_BATCH_CONSTRAINT,
  SCHEDULE_REQUEST_BATCH_INDEX,
  SCHEDULE_REQUEST_BATCH_MIGRATION_ID,
  SCHEDULE_REQUEST_BATCH_MIGRATION_SQL,
  SCHEDULE_REQUEST_BATCH_PREFLIGHT_SQL,
} from '../src/database/migrations/schedule-request-batch.migration';

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

async function state(executor?: { query: (sql: string, params?: unknown[]) => Promise<unknown[]> }) {
  const query = executor?.query.bind(executor) ?? dataSource.query.bind(dataSource);
  const columns = await query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='schedule_requests'
        AND column_name = ANY($1)
      ORDER BY column_name`,
    [['batch_key', 'batch_fingerprint', 'batch_index']],
  );
  const [constraint] = await query(
    `SELECT convalidated
       FROM pg_constraint
      WHERE conrelid='public.schedule_requests'::regclass AND conname=$1`,
    [SCHEDULE_REQUEST_BATCH_CONSTRAINT],
  );
  const [index] = await query(
    `SELECT i.indisvalid, i.indisready
       FROM pg_index i
       JOIN pg_class c ON c.oid=i.indexrelid
      WHERE c.relname=$1`,
    [SCHEDULE_REQUEST_BATCH_INDEX],
  );
  const [ledger] = await query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [SCHEDULE_REQUEST_BATCH_MIGRATION_ID],
  );
  return {
    columns,
    constraintValidated: constraint?.convalidated === true,
    indexValid: index?.indisvalid === true && index?.indisready === true,
    ledgerApplied: ledger?.applied === true,
  };
}

function complete(value: Awaited<ReturnType<typeof state>>): boolean {
  return value.columns.length === 3
    && value.constraintValidated
    && value.indexValid;
}

async function main(): Promise<void> {
  await dataSource.initialize();
  await dataSource.query(SCHEDULE_REQUEST_BATCH_PREFLIGHT_SQL);
  const before = await state();
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SCHEDULE_REQUEST_BATCH_MIGRATION_ID,
      current: before,
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [78, 2]);
    const current = await state(manager);
    if (!complete(current)) {
      for (const sql of SCHEDULE_REQUEST_BATCH_MIGRATION_SQL) {
        try {
          await manager.query(sql);
        } catch (error) {
          const code = (error as { code?: string })?.code
            ?? (error as { driverError?: { code?: string } })?.driverError?.code;
          if (code !== '42701' && code !== '42710' && code !== '42P07') throw error;
        }
      }
    }
    const verified = await state(manager);
    if (!complete(verified)) throw new Error('schedule request batch schema is incomplete');
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [SCHEDULE_REQUEST_BATCH_MIGRATION_ID],
    );
  });

  const after = await state();
  if (!complete(after) || !after.ledgerApplied) {
    throw new Error('schedule request batch migration readback failed');
  }
  console.log(JSON.stringify({
    ok: true,
    migration: SCHEDULE_REQUEST_BATCH_MIGRATION_ID,
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
