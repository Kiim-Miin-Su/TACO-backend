import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEDULE_REQUEST_INTEGRITY_V2_ADD_SQL,
  SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS,
  SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID,
  SCHEDULE_REQUEST_INTEGRITY_V2_PREFLIGHT_SQL,
} from '../src/database/migrations/schedule-request-integrity-v2.migration';

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

async function readState(runner?: QueryRunner) {
  const query = runner?.query.bind(runner) ?? dataSource.query.bind(dataSource);
  const constraints = await query(
    `SELECT conname, convalidated, pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint
      WHERE conrelid='public.schedule_requests'::regclass AND conname = ANY($1)
      ORDER BY conname`,
    [[...SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS]],
  );
  const [ledger] = await query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID],
  );
  return { constraints, ledgerApplied: ledger.applied === true };
}

function complete(state: Awaited<ReturnType<typeof readState>>): boolean {
  return state.constraints.length === SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS.length
    && state.constraints.every((row: { convalidated: boolean }) => row.convalidated);
}

async function shortTransaction(
  runner: QueryRunner,
  work: () => Promise<void>,
): Promise<void> {
  await runner.startTransaction();
  try {
    await work();
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  }
}

async function main(): Promise<void> {
  await dataSource.initialize();
  await dataSource.query(SCHEDULE_REQUEST_INTEGRITY_V2_PREFLIGHT_SQL);
  const before = await readState();
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID,
      current: before,
    }, null, 2));
    return;
  }

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock($1, $2)', [77, 31]);

    for (let index = 0; index < SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS.length; index += 1) {
      const constraint = SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS[index];
      const [found] = await runner.query(
        `SELECT convalidated FROM pg_constraint
          WHERE conrelid='public.schedule_requests'::regclass AND conname=$1`,
        [constraint],
      );
      if (!found) {
        await shortTransaction(runner, () => runner.query(SCHEDULE_REQUEST_INTEGRITY_V2_ADD_SQL[index]));
      }
      const [fresh] = await runner.query(
        `SELECT convalidated FROM pg_constraint
          WHERE conrelid='public.schedule_requests'::regclass AND conname=$1`,
        [constraint],
      );
      if (!fresh?.convalidated) {
        await runner.query(`ALTER TABLE schedule_requests VALIDATE CONSTRAINT "${constraint}"`);
      }
    }

    const verified = await readState(runner);
    if (!complete(verified)) {
      throw new Error('schedule request v2 constraints are incomplete; ledger was not written');
    }
    if (!verified.ledgerApplied) {
      await shortTransaction(runner, async () => {
        await runner.query(
          'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
          [SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID],
        );
      });
    }
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    try {
      await runner.query('SELECT pg_advisory_unlock($1, $2)', [77, 31]);
    } finally {
      await runner.release();
    }
  }

  const after = await readState();
  if (!complete(after) || !after.ledgerApplied) {
    throw new Error('schedule request v2 migration readback failed');
  }
  console.log(JSON.stringify({
    ok: true,
    migration: SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID,
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
