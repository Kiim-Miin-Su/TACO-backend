import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEDULE_REQUEST_INTEGRITY_CONSTRAINTS,
  SCHEDULE_REQUEST_INTEGRITY_MIGRATION_ID,
} from '../src/database/migrations/schedule-request-integrity.migration';
import {
  SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS,
  SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID,
} from '../src/database/migrations/schedule-request-integrity-v2.migration';

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

type PgFailure = { code?: string; constraint?: string; message?: string };

function pgFailure(error: unknown): PgFailure {
  const outer = error as { driverError?: PgFailure };
  return outer.driverError ?? (error as PgFailure);
}

async function expectRejected(
  runner: QueryRunner,
  name: string,
  sql: string,
  params: unknown[],
  expectedCode: string,
  expectedConstraint: string,
): Promise<{ name: string; code: string; constraint: string }> {
  await runner.query(`SAVEPOINT "${name}"`);
  try {
    await runner.query(sql, params);
    throw new Error(`${name}: invalid DML was accepted`);
  } catch (error) {
    await runner.query(`ROLLBACK TO SAVEPOINT "${name}"`);
    if (error instanceof Error && error.message.includes('invalid DML was accepted')) throw error;
    const failure = pgFailure(error);
    if (failure.code !== expectedCode || failure.constraint !== expectedConstraint) {
      throw new Error(
        `${name}: expected ${expectedCode}/${expectedConstraint}, got `
        + `${failure.code ?? 'unknown'}/${failure.constraint ?? 'unknown'}: ${failure.message ?? ''}`,
      );
    }
    return { name, code: failure.code, constraint: failure.constraint };
  } finally {
    await runner.query(`RELEASE SAVEPOINT "${name}"`);
  }
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const [user] = await dataSource.query(
    "SELECT id FROM users WHERE deleted_at IS NULL AND status='active' ORDER BY id LIMIT 1",
  );
  const [course] = await dataSource.query(
    'SELECT id FROM courses WHERE deleted_at IS NULL ORDER BY id LIMIT 1',
  );
  const [session] = await dataSource.query(
    'SELECT id FROM class_sessions WHERE deleted_at IS NULL ORDER BY id LIMIT 1',
  );
  const [availability] = await dataSource.query(
    'SELECT id FROM availability_blocks WHERE deleted_at IS NULL ORDER BY id LIMIT 1',
  );
  if (!user || !course || !session || !availability) {
    throw new Error('active user/course/session/availability fixtures are required');
  }

  const allConstraints = [
    ...SCHEDULE_REQUEST_INTEGRITY_CONSTRAINTS,
    ...SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS,
  ];
  const constraints = await dataSource.query(
    `SELECT conname, convalidated
       FROM pg_constraint
      WHERE conrelid='public.schedule_requests'::regclass AND conname = ANY($1)
      ORDER BY conname`,
    [allConstraints],
  );
  const ledger = await dataSource.query(
    'SELECT id FROM schema_migrations WHERE id = ANY($1)',
    [[SCHEDULE_REQUEST_INTEGRITY_MIGRATION_ID, SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID]],
  );
  if (
    constraints.length !== allConstraints.length
    || !constraints.every((row: { convalidated: boolean }) => row.convalidated)
    || ledger.length !== 2
  ) {
    throw new Error('schedule request constraints or migration ledger are incomplete');
  }

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    const acceptedCases = [
      {
        sql: `INSERT INTO schedule_requests
        (requester_id, request_kind, course_id, instructor_id, session_date, start_time,
         duration_minutes, kind, mode, status)
       VALUES ($1, 'session_create', $2, $1, CURRENT_DATE, '10:00', 60, 'class', 'online', 'pending')`,
        params: [user.id, course.id],
      },
      {
        sql: `INSERT INTO schedule_requests
        (requester_id, request_kind, target_session_id, course_id, instructor_id, session_date,
         start_time, duration_minutes, kind, mode, scope, request_reason, status)
       VALUES ($1, 'session_update', $3, $2, $1, CURRENT_DATE, '10:00', 60,
         'class', 'online', 'this', '정상 변경 요청', 'pending')`,
        params: [user.id, course.id, session.id],
      },
      {
        sql: `INSERT INTO schedule_requests
        (requester_id, request_kind, target_session_id, course_id, instructor_id, session_date,
         start_time, duration_minutes, kind, mode, scope, request_reason, status)
       VALUES ($1, 'session_delete', $3, $2, $1, CURRENT_DATE, '10:00', 60,
         'class', 'online', 'this', '정상 삭제 요청', 'pending')`,
        params: [user.id, course.id, session.id],
      },
      {
        sql: `INSERT INTO schedule_requests
        (requester_id, request_kind, availability_owner_type, availability_owner_id,
         availability_kind, availability_weekday, availability_start_time,
         availability_end_time, request_reason, status)
       VALUES ($1, 'availability_upsert', 'instructor', $1, 'available', 1,
         '09:00', '10:00', '정상 가용 변경', 'pending')`,
        params: [user.id],
      },
      {
        sql: `INSERT INTO schedule_requests
        (requester_id, request_kind, target_availability_id, availability_owner_type,
         availability_owner_id, availability_kind, availability_weekday,
         availability_start_time, availability_end_time, request_reason, status)
       VALUES ($1, 'availability_delete', $2, 'instructor', $1, 'available', 1,
         '09:00', '10:00', '정상 가용 삭제', 'pending')`,
        params: [user.id, availability.id],
      },
    ];
    for (const testCase of acceptedCases) {
      await runner.query(testCase.sql, testCase.params);
    }

    const rejected = [
      await expectRejected(
        runner,
        'delete_snapshot',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, target_session_id, request_reason, status)
         VALUES ($1, 'session_delete', $2, '스냅샷 누락', 'pending')`,
        [user.id, session.id],
        '23514',
        'c_schedule_requests_kind_required_v2',
      ),
      await expectRejected(
        runner,
        'availability_delete_snapshot',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, target_availability_id, request_reason, status)
         VALUES ($1, 'availability_delete', $2, '스냅샷 누락', 'pending')`,
        [user.id, availability.id],
        '23514',
        'c_schedule_requests_kind_required_v2',
      ),
      await expectRejected(
        runner,
        'approved_wrong_output',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, target_session_id, course_id, instructor_id,
           session_date, start_time, duration_minutes, scope, request_reason, status,
           decided_by, decided_at, created_session_id)
         VALUES ($1, 'session_delete', $2, $3, $1, CURRENT_DATE, '10:00', 60,
           'this', '잘못된 승인 산출물', 'approved', $1, now(), $2)`,
        [user.id, session.id, course.id],
        '23514',
        'c_schedule_requests_decision_complete_v2',
      ),
      await expectRejected(
        runner,
        'invalid_domain',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, course_id, instructor_id, session_date, start_time,
           duration_minutes, mode, status)
         VALUES ($1, 'session_create', $2, $1, CURRENT_DATE, '10:00', 60, 'offline', 'pending')`,
        [user.id, course.id],
        '23514',
        'c_schedule_requests_domain_semantics_v2',
      ),
      await expectRejected(
        runner,
        'invalid_delete_time',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, target_session_id, course_id, instructor_id,
           session_date, start_time, duration_minutes, scope, request_reason, status)
         VALUES ($1, 'session_delete', $2, $3, $1, CURRENT_DATE, '29:00', 60,
           'this', '잘못된 시간', 'pending')`,
        [user.id, session.id, course.id],
        '23514',
        'c_schedule_requests_time_semantics_v2',
      ),
      await expectRejected(
        runner,
        'invalid_requester_fk',
        `INSERT INTO schedule_requests
          (requester_id, request_kind, course_id, instructor_id, session_date, start_time,
           duration_minutes, status)
         VALUES (-2147483648, 'session_create', $1, $2, CURRENT_DATE, '10:00', 60, 'pending')`,
        [course.id, user.id],
        '23503',
        'fk_schedule_requests_requester',
      ),
    ];

    console.log(JSON.stringify({
      ok: true,
      migrations: [SCHEDULE_REQUEST_INTEGRITY_MIGRATION_ID, SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID],
      constraints: constraints.length,
      acceptedKinds: acceptedCases.length,
      rejected,
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
