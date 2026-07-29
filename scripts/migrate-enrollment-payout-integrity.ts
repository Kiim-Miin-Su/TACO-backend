import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS,
  ENROLLMENT_PAYOUT_INTEGRITY_INDEXES,
  ENROLLMENT_PAYOUT_INTEGRITY_INDEX_SQL,
  ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID,
  ENROLLMENT_PAYOUT_INTEGRITY_SQL,
} from '../src/database/migrations/enrollment-payout-integrity.migration';

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

type QueryRow = Record<string, unknown>;
type Query = (sql: string, params?: unknown[]) => Promise<QueryRow[]>;

async function state(query: Query = (sql, params) => dataSource.query(sql, params)) {
  const constraints = await query(
    `SELECT conname, conrelid::regclass::text AS table_name, contype, convalidated
       FROM pg_constraint
      WHERE conname = ANY($1)
      ORDER BY conname`,
    [[...ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS]],
  );
  const indexes = await query(
    `SELECT indexrelid::regclass::text AS index_name, indisvalid, indisready
       FROM pg_index
      WHERE indexrelid::regclass::text = ANY($1)
      ORDER BY index_name`,
    [[...ENROLLMENT_PAYOUT_INTEGRITY_INDEXES]],
  );
  const [ledger] = await query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID],
  );
  return { constraints, indexes, ledgerApplied: ledger.applied === true };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  await dataSource.query(ENROLLMENT_PAYOUT_INTEGRITY_SQL[0]);
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID,
      current: await state(),
    }, null, 2));
    return;
  }

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock($1, $2)', [77, 31]);
    await runner.startTransaction();
    try {
      for (const sql of ENROLLMENT_PAYOUT_INTEGRITY_SQL) await runner.query(sql);
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }

    for (const sql of ENROLLMENT_PAYOUT_INTEGRITY_INDEX_SQL) await runner.query(sql);

    const beforeLedger = await state((sql, params) => runner.query(sql, params));
    if (
      beforeLedger.constraints.length !== ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS.length
      || !beforeLedger.constraints.every((row) => row.convalidated === true)
      || beforeLedger.indexes.length !== ENROLLMENT_PAYOUT_INTEGRITY_INDEXES.length
      || !beforeLedger.indexes.every((row) => row.indisvalid === true && row.indisready === true)
    ) {
      throw new Error('enrollment/payout constraints or indexes failed readback');
    }

    await runner.startTransaction();
    try {
      await runner.query(
        'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID],
      );
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    try {
      await runner.query('SELECT pg_advisory_unlock($1, $2)', [77, 31]);
    } finally {
      await runner.release();
    }
  }

  const after = await state();
  if (!after.ledgerApplied) throw new Error('enrollment/payout migration ledger readback failed');
  console.log(JSON.stringify({ ok: true, migration: ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
