import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS,
  ENROLLMENT_PAYOUT_INTEGRITY_INDEXES,
  ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID,
} from '../src/database/migrations/enrollment-payout-integrity.migration';

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

async function expectRejected(runner: QueryRunner, name: string, sql: string, params: unknown[]): Promise<void> {
  await runner.query(`SAVEPOINT ${name}`);
  try {
    await runner.query(sql, params);
    throw new Error(`${name}: invalid DML was accepted`);
  } catch (error) {
    await runner.query(`ROLLBACK TO SAVEPOINT ${name}`);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('invalid DML was accepted')) throw error;
  } finally {
    await runner.query(`RELEASE SAVEPOINT ${name}`);
  }
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const [refs] = await dataSource.query(`
    SELECT
      (SELECT id FROM users WHERE deleted_at IS NULL AND status='active' ORDER BY id LIMIT 1) AS user_id,
      (SELECT id FROM students ORDER BY id LIMIT 1) AS student_id,
      (SELECT id FROM courses ORDER BY id LIMIT 1) AS course_id,
      (SELECT id FROM class_sessions ORDER BY id LIMIT 1) AS session_id
  `);
  if (!refs?.user_id || !refs?.student_id || !refs?.course_id || !refs?.session_id) {
    throw new Error('user/student/course/session fixtures are required');
  }

  const constraints = await dataSource.query(
    `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1)`,
    [[...ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS]],
  );
  const indexes = await dataSource.query(
    `SELECT indexrelid::regclass::text AS index_name, indisvalid, indisready
       FROM pg_index WHERE indexrelid::regclass::text = ANY($1)`,
    [[...ENROLLMENT_PAYOUT_INTEGRITY_INDEXES]],
  );
  const [ledger] = await dataSource.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID],
  );
  if (
    constraints.length !== ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS.length
    || !constraints.every((row: { convalidated: boolean }) => row.convalidated)
    || indexes.length !== ENROLLMENT_PAYOUT_INTEGRITY_INDEXES.length
    || !indexes.every((row: { indisvalid: boolean; indisready: boolean }) => row.indisvalid && row.indisready)
    || ledger.applied !== true
  ) {
    throw new Error('enrollment/payout schema readback is incomplete');
  }

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const [validPayout] = await runner.query(
      `INSERT INTO instructor_payouts
        (instructor_id, period_start, period_end, session_count, total_minutes,
         computed_amount, amount, status, lines)
       VALUES ($1, CURRENT_DATE, CURRENT_DATE, 1, 60, 10000, 10000, 'pending', $2)
       RETURNING id`,
      [
        refs.user_id,
        JSON.stringify([{
          sessionId: Number(refs.session_id),
          courseId: Number(refs.course_id),
          courseName: 'integrity fixture',
          sessionDate: new Date().toISOString().slice(0, 10),
          durationMinutes: 60,
          hourlyRate: 10000,
          amount: 10000,
        }]),
      ],
    );

    await runner.query('UPDATE instructor_payouts SET status=$1, confirmed_at=now() WHERE id=$2', ['confirmed', validPayout.id]);
    await runner.query('UPDATE instructor_payouts SET status=$1, paid_at=now() WHERE id=$2', ['paid', validPayout.id]);
    await runner.query(
      `UPDATE instructor_payouts
          SET status='rejected', rejected_reason='fixture reversal',
              reversed_at=now(), reversed_reason='fixture reversal'
        WHERE id=$1`,
      [validPayout.id],
    );

    await expectRejected(
      runner,
      'invalid_enrollment_fk',
      `INSERT INTO enrollments (student_id, course_id, status, enrolled_at)
       VALUES (-2147483648, $1, 'active', CURRENT_DATE)`,
      [refs.course_id],
    );
    await expectRejected(
      runner,
      'invalid_enrollment_dates',
      `INSERT INTO enrollments (student_id, course_id, status, start_date, end_date, enrolled_at)
       VALUES ($1, $2, 'active', CURRENT_DATE, CURRENT_DATE - 1, CURRENT_DATE)`,
      [refs.student_id, refs.course_id],
    );
    await expectRejected(
      runner,
      'invalid_payout_amount',
      `INSERT INTO instructor_payouts
        (instructor_id, period_start, period_end, session_count, total_minutes,
         computed_amount, amount, status, lines)
       VALUES ($1, CURRENT_DATE, CURRENT_DATE, 1, 60, 10000, 9999, 'pending', $2)`,
      [refs.user_id, JSON.stringify([{ sessionId: refs.session_id }])],
    );
    await expectRejected(
      runner,
      'invalid_payout_status_metadata',
      `INSERT INTO instructor_payouts
        (instructor_id, period_start, period_end, session_count, total_minutes,
         computed_amount, amount, status, lines)
       VALUES ($1, CURRENT_DATE, CURRENT_DATE, 1, 60, 10000, 10000, 'paid', $2)`,
      [refs.user_id, JSON.stringify([{ sessionId: refs.session_id }])],
    );

    await runner.query('UPDATE users SET deleted_at=deleted_at WHERE id=$1', [refs.user_id]);
    console.log(JSON.stringify({
      ok: true,
      migration: ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID,
      constraints: constraints.length,
      indexes: indexes.length,
      validTransitions: 4,
      negativeCases: 4,
      parentSoftDeleteAllowed: true,
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
