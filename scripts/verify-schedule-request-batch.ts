import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEDULE_REQUEST_BATCH_CONSTRAINT,
  SCHEDULE_REQUEST_BATCH_INDEX,
  SCHEDULE_REQUEST_BATCH_MIGRATION_ID,
} from '../src/database/migrations/schedule-request-batch.migration';

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

function pgError(error: unknown): { code?: string; constraint?: string } {
  const candidate = error as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  return {
    code: candidate.code ?? candidate.driverError?.code,
    constraint: candidate.constraint ?? candidate.driverError?.constraint,
  };
}

async function expectRejected(
  runner: QueryRunner,
  sql: string,
  params: unknown[],
  expectedCode: string,
  expectedConstraint: string,
): Promise<void> {
  await runner.query('SAVEPOINT expected_failure');
  try {
    await runner.query(sql, params);
    throw new Error(`expected ${expectedConstraint} rejection`);
  } catch (error) {
    const found = pgError(error);
    if (found.code !== expectedCode || found.constraint !== expectedConstraint) {
      throw new Error(
        `unexpected rejection: expected ${expectedCode}/${expectedConstraint}, got ${found.code}/${found.constraint}`,
      );
    }
  } finally {
    await runner.query('ROLLBACK TO SAVEPOINT expected_failure');
  }
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const [schema] = await dataSource.query(
    `SELECT
       EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS ledger,
       EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid='public.schedule_requests'::regclass
            AND conname=$2 AND convalidated
       ) AS constraint_validated,
       EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_class c ON c.oid=i.indexrelid
          WHERE c.relname=$3 AND i.indisvalid AND i.indisready
       ) AS index_valid`,
    [SCHEDULE_REQUEST_BATCH_MIGRATION_ID, SCHEDULE_REQUEST_BATCH_CONSTRAINT, SCHEDULE_REQUEST_BATCH_INDEX],
  );
  if (!schema?.ledger || !schema?.constraint_validated || !schema?.index_valid) {
    throw new Error('schedule request batch schema is incomplete');
  }

  const [source] = await dataSource.query(
    `SELECT c.id AS course_id, c.instructor_id AS requester_id
       FROM courses c
       JOIN users u ON u.id=c.instructor_id
      WHERE c.deleted_at IS NULL
        AND c.status='active'
        AND u.deleted_at IS NULL
        AND u.status='active'
      ORDER BY c.id
      LIMIT 1`,
  );
  if (!source) throw new Error('rollback verifier requires one active course with an active instructor');

  const batchKey = randomUUID();
  const fingerprint = 'a'.repeat(64);
  const insertSql = `
    INSERT INTO schedule_requests (
      requester_id, request_kind, course_id, instructor_id, room_id,
      session_date, start_time, end_time, duration_minutes, kind, mode,
      topic, memo, student_ids, request_reason, status,
      batch_key, batch_fingerprint, batch_index
    ) VALUES (
      $1, 'session_create', $2, $3, $4,
      $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, 'pending',
      $15, $16, $17
    ) RETURNING id`;

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const values = [
      source.requester_id,
      source.course_id,
      source.requester_id,
      null,
      '2099-12-01',
      '06:00',
      '07:00',
      60,
      'class',
      'online',
      'rollback batch verifier',
      null,
      '[]',
      null,
      batchKey,
      fingerprint,
      0,
    ];
    const [accepted] = await runner.query(insertSql, values);
    if (!accepted?.id) throw new Error('valid batch fixture was not inserted');

    await expectRejected(runner, insertSql, values, '23505', SCHEDULE_REQUEST_BATCH_INDEX);
    await expectRejected(
      runner,
      `UPDATE schedule_requests
          SET batch_key=$1, batch_fingerprint=NULL, batch_index=1
        WHERE id=$2`,
      [randomUUID(), accepted.id],
      '23514',
      SCHEDULE_REQUEST_BATCH_CONSTRAINT,
    );
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    await runner.release();
  }

  console.log(JSON.stringify({
    ok: true,
    migration: SCHEDULE_REQUEST_BATCH_MIGRATION_ID,
    accepted: 1,
    rejected: [
      { code: '23505', constraint: SCHEDULE_REQUEST_BATCH_INDEX },
      { code: '23514', constraint: SCHEDULE_REQUEST_BATCH_CONSTRAINT },
    ],
    persistedRows: 0,
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
