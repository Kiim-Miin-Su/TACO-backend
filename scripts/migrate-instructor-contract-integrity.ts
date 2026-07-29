import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  INSTRUCTOR_CONTRACT_CONSTRAINTS,
  INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID,
  INSTRUCTOR_CONTRACT_INTEGRITY_SQL,
} from '../src/database/migrations/instructor-contract-integrity.migration';
import {
  INSTRUCTOR_CONTRACT_BOUNDS_MIGRATION_ID,
  INSTRUCTOR_CONTRACT_BOUNDS_SQL,
} from '../src/database/migrations/instructor-contract-bounds.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');
const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function state(): Promise<Record<string, unknown>> {
  const constraints = await dataSource.query(
    `SELECT conname, contype, convalidated, pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint
      WHERE conrelid='public.instructor_contracts'::regclass AND conname = ANY($1)
      ORDER BY conname`,
    [[...INSTRUCTOR_CONTRACT_CONSTRAINTS]],
  );
  const [ledgerTable] = await dataSource.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`);
  const ledgerApplied = ledgerTable.present
    ? (await dataSource.query('SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied', [INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID]))[0].applied === true
    : false;
  const boundsLedgerApplied = ledgerTable.present
    ? (await dataSource.query('SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied', [INSTRUCTOR_CONTRACT_BOUNDS_MIGRATION_ID]))[0].applied === true
    : false;
  return { constraints, ledgerApplied, boundsLedgerApplied };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    await dataSource.query(INSTRUCTOR_CONTRACT_INTEGRITY_SQL[0]);
    await dataSource.query(INSTRUCTOR_CONTRACT_BOUNDS_SQL[0]);
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID, current: await state() }, null, 2));
    return;
  }
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock($1, $2)', [77, 3]);
    await runner.startTransaction();
    try {
      await runner.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id varchar(100) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = await runner.query('SELECT id FROM schema_migrations WHERE id=$1', [INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID]);
      if (!applied.length) {
        for (const sql of INSTRUCTOR_CONTRACT_INTEGRITY_SQL) await runner.query(sql);
        await runner.query('INSERT INTO schema_migrations (id) VALUES ($1)', [INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID]);
      }
      const boundsApplied = await runner.query('SELECT id FROM schema_migrations WHERE id=$1', [INSTRUCTOR_CONTRACT_BOUNDS_MIGRATION_ID]);
      if (!boundsApplied.length) {
        for (const sql of INSTRUCTOR_CONTRACT_BOUNDS_SQL) await runner.query(sql);
        await runner.query('INSERT INTO schema_migrations (id) VALUES ($1)', [INSTRUCTOR_CONTRACT_BOUNDS_MIGRATION_ID]);
      }
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    try {
      await runner.query('SELECT pg_advisory_unlock($1, $2)', [77, 3]);
    } finally {
      await runner.release();
    }
  }
  const after = await state();
  const constraints = after.constraints as Array<{ convalidated: boolean }>;
  if (
    constraints.length !== INSTRUCTOR_CONTRACT_CONSTRAINTS.length
    || !constraints.every((row) => row.convalidated)
    || after.ledgerApplied !== true
    || after.boundsLedgerApplied !== true
  ) {
    throw new Error('instructor contract integrity migration readback failed');
  }
  console.log(JSON.stringify({ ok: true, migration: INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
