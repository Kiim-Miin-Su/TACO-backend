import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  TRANSACTION_SOURCE_CONSTRAINTS,
  TRANSACTION_SOURCE_INTEGRITY_MIGRATION_ID,
  TRANSACTION_SOURCE_INTEGRITY_SQL,
} from '../src/database/migrations/transaction-source-integrity.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');
const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function state() {
  const constraints = await dataSource.query(
    `SELECT conname, contype, convalidated, pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint
      WHERE conrelid='public.transactions'::regclass AND conname = ANY($1)
      ORDER BY conname`,
    [[...TRANSACTION_SOURCE_CONSTRAINTS]],
  );
  const [ledger] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`,
    [TRANSACTION_SOURCE_INTEGRITY_MIGRATION_ID],
  );
  return { constraints, ledgerApplied: ledger.applied === true };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    await dataSource.query(TRANSACTION_SOURCE_INTEGRITY_SQL[0]);
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: TRANSACTION_SOURCE_INTEGRITY_MIGRATION_ID, current: await state() }, null, 2));
    return;
  }
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock($1, $2)', [77, 5]);
    await runner.startTransaction();
    try {
      const applied = await runner.query('SELECT id FROM schema_migrations WHERE id=$1', [TRANSACTION_SOURCE_INTEGRITY_MIGRATION_ID]);
      if (!applied.length) {
        for (const sql of TRANSACTION_SOURCE_INTEGRITY_SQL) await runner.query(sql);
        await runner.query('INSERT INTO schema_migrations (id) VALUES ($1)', [TRANSACTION_SOURCE_INTEGRITY_MIGRATION_ID]);
      }
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    try {
      await runner.query('SELECT pg_advisory_unlock($1, $2)', [77, 5]);
    } finally {
      await runner.release();
    }
  }
  const after = await state();
  if (
    after.constraints.length !== TRANSACTION_SOURCE_CONSTRAINTS.length
    || !after.constraints.every((row: { convalidated: boolean }) => row.convalidated)
    || !after.ledgerApplied
  ) throw new Error('transaction source integrity migration readback failed');
  console.log(JSON.stringify({ ok: true, migration: TRANSACTION_SOURCE_INTEGRITY_MIGRATION_ID, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
