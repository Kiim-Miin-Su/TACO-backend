import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_CONSTRAINTS,
  SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_INDEX,
  SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_MIGRATION_ID,
  SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_SQL,
} from '../src/database/migrations/schedule-request-attendance-correction.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('A direct database URL is required');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false,
  entities: [], migrations: [], ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

type Executor = { query: (sql: string, params?: unknown[]) => Promise<unknown[]> };

async function state(executor: Executor = dataSource) {
  const columns = await executor.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='schedule_requests'
        AND column_name = ANY($1::text[]) ORDER BY column_name`,
    [['instructor_attendance_before', 'requested_instructor_attendance']],
  ) as Array<{ column_name: string }>;
  const constraints = await executor.query(
    `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid='public.schedule_requests'::regclass
        AND conname = ANY($1::text[]) ORDER BY conname`,
    [[...SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_CONSTRAINTS]],
  ) as Array<{ conname: string; convalidated: boolean; definition: string }>;
  const [index] = await executor.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
    [SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_INDEX],
  ) as Array<{ indexdef?: string }>;
  const hasAttendanceColumns = columns.length === 2;
  const [invalid] = hasAttendanceColumns
    ? await executor.query(
      `SELECT count(*)::int AS count FROM schedule_requests
        WHERE request_kind='instructor_attendance_correction' AND NOT (
          target_session_id IS NOT NULL AND course_id IS NOT NULL
          AND instructor_id IS NOT NULL AND requester_id=instructor_id
          AND session_date IS NOT NULL AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
          AND requested_instructor_attendance IN ('present','late','absent','makeup')
          AND (instructor_attendance_before IS NULL OR instructor_attendance_before IN ('present','late','absent','makeup'))
          AND requested_instructor_attendance IS DISTINCT FROM instructor_attendance_before
          AND length(btrim(COALESCE(request_reason, ''))) > 0
        )`,
    ) as Array<{ count: number }>
    : [{ count: -1 }];
  const [ledgerTable] = await executor.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists`,
  ) as Array<{ exists: boolean }>;
  const [ledger] = ledgerTable?.exists
    ? await executor.query(
      `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`,
      [SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_MIGRATION_ID],
    ) as Array<{ applied: boolean }>
    : [{ applied: false }];
  return {
    columns: columns.map((row) => row.column_name),
    constraints,
    indexDefinition: index?.indexdef ?? null,
    invalidCount: invalid?.count ?? -1,
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (value: Awaited<ReturnType<typeof state>>) =>
  value.columns.length === 2
  && value.constraints.length === SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_CONSTRAINTS.length
  && value.constraints.every((row) => row.convalidated)
  && value.constraints.some((row) => row.definition.includes('instructor_attendance_correction'))
  && value.indexDefinition?.includes(SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_INDEX) === true
  && value.indexDefinition?.includes("'instructor_attendance_correction'") === true
  && value.invalidCount === 0;

async function main() {
  await dataSource.initialize();
  const before = await state();
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 3]);
      for (const sql of SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_SQL) await manager.query(sql);
      const preview = await state(manager);
      if (!complete(preview)) {
        throw new Error(`attendance correction dry-run readback failed: ${JSON.stringify(preview)}`);
      }
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await state();
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback),
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [86, 3]);
    if (!complete(await state(manager))) {
      for (const sql of SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_SQL) await manager.query(sql);
    }
    if (!complete(await state(manager))) throw new Error('attendance correction migration readback failed');
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_MIGRATION_ID],
    );
  });
  const after = await state();
  if (!complete(after) || !after.ledgerApplied) {
    throw new Error('attendance correction migration ledger/readback failed');
  }
  console.log(JSON.stringify({
    ok: true,
    migration: SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_MIGRATION_ID,
    after,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
