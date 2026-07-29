import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEDULE_REQUEST_INTEGRITY_CONSTRAINTS,
  SCHEDULE_REQUEST_INTEGRITY_MIGRATION_ID,
} from '../src/database/migrations/schedule-request-integrity.migration';

loadLocalEnv();
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

async function expectRejected(runner: QueryRunner, name: string, sql: string, params: unknown[]): Promise<string> {
  await runner.query(`SAVEPOINT ${name}`);
  try {
    await runner.query(sql, params);
    throw new Error(`${name}: invalid DML was accepted`);
  } catch (error) {
    await runner.query(`ROLLBACK TO SAVEPOINT ${name}`);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('invalid DML was accepted')) throw error;
    return message;
  } finally {
    await runner.query(`RELEASE SAVEPOINT ${name}`);
  }
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const [user] = await dataSource.query(
    "SELECT id FROM users WHERE deleted_at IS NULL AND status='active' ORDER BY id LIMIT 1",
  );
  if (!user) throw new Error('active user fixture is required');

  const constraints = await dataSource.query(
    `SELECT conname, convalidated
       FROM pg_constraint
      WHERE conrelid='public.schedule_requests'::regclass AND conname = ANY($1)
      ORDER BY conname`,
    [[...SCHEDULE_REQUEST_INTEGRITY_CONSTRAINTS]],
  );
  const [ledger] = await dataSource.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [SCHEDULE_REQUEST_INTEGRITY_MIGRATION_ID],
  );
  if (
    constraints.length !== SCHEDULE_REQUEST_INTEGRITY_CONSTRAINTS.length
    || !constraints.every((row: { convalidated: boolean }) => row.convalidated)
    || ledger.applied !== true
  ) {
    throw new Error('schedule request constraints or ledger are incomplete');
  }

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const results = [
      await expectRejected(
        runner,
        'invalid_kind_required',
        "INSERT INTO schedule_requests (requester_id, request_kind, status) VALUES ($1, 'session_create', 'pending')",
        [user.id],
      ),
      await expectRejected(
        runner,
        'invalid_pending_decision',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, course_id, instructor_id, session_date, start_time,
           duration_minutes, status, decided_by, decided_at)
         VALUES ($1, 'session_create', 1, $1, CURRENT_DATE, '10:00', 60, 'pending', $1, now())`,
        [user.id],
      ),
      await expectRejected(
        runner,
        'invalid_rejected_reason',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, course_id, instructor_id, session_date, start_time,
           duration_minutes, status, decided_by, decided_at)
         VALUES ($1, 'session_create', 1, $1, CURRENT_DATE, '10:00', 60, 'rejected', $1, now())`,
        [user.id],
      ),
      await expectRejected(
        runner,
        'invalid_requester_fk',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, course_id, instructor_id, session_date, start_time,
           duration_minutes, status)
         VALUES (-2147483648, 'session_create', 1, $1, CURRENT_DATE, '10:00', 60, 'pending')`,
        [user.id],
      ),
    ];
    console.log(JSON.stringify({
      ok: true,
      migration: SCHEDULE_REQUEST_INTEGRITY_MIGRATION_ID,
      constraints: constraints.length,
      negativeCases: results.length,
    }, null, 2));
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
