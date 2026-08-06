import 'reflect-metadata';
import { DataSource, QueryRunner } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';

loadLocalEnv();

const FROM = process.env.GO_LIVE_FROM ?? '2026-07-01';
const TO = process.env.GO_LIVE_TO ?? '2026-07-31';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

if (!ISO_DATE.test(FROM) || !ISO_DATE.test(TO) || FROM > TO) {
  throw new Error('GO_LIVE_FROM/GO_LIVE_TO must be a valid ascending YYYY-MM-DD range');
}

const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');

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

async function query<T>(runner: QueryRunner, sql: string, params: unknown[] = []): Promise<T[]> {
  return runner.query(sql, params) as Promise<T[]>;
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();

  try {
    await runner.query('SET TRANSACTION READ ONLY');
    const params = [FROM, TO];
    const [database] = await query<{ database: string; role: string; version: string; checkedAt: string }>(runner, `
      SELECT current_database() AS database,
             current_user AS role,
             current_setting('server_version') AS version,
             now()::text AS "checkedAt"
    `);
    const sessions = await query(runner, `
      SELECT instructor_id AS "instructorId",
             COUNT(*)::int AS "sessionCount",
             COALESCE(SUM(duration_minutes), 0)::int AS "totalMinutes",
             COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled,
             COUNT(*) FILTER (WHERE status = 'held')::int AS held,
             COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled,
             COUNT(*) FILTER (WHERE instructor_attendance IS NULL)::int AS "instructorAttendanceMissing",
             COUNT(*) FILTER (WHERE payout_id IS NOT NULL)::int AS "payoutLinked",
             COUNT(*) FILTER (WHERE is_paid)::int AS paid
        FROM class_sessions
       WHERE deleted_at IS NULL AND session_date BETWEEN $1::date AND $2::date
       GROUP BY instructor_id
       ORDER BY instructor_id
    `, params);
    const reports = await query(runner, `
      SELECT s.instructor_id AS "instructorId",
             COUNT(r.id)::int AS "reportCount",
             COUNT(r.id) FILTER (WHERE r.approval_status = 'approved')::int AS approved,
             COUNT(r.id) FILTER (WHERE r.status = 'draft')::int AS draft,
             COUNT(r.id) FILTER (WHERE r.approval_status = 'rejected')::int AS rejected
        FROM class_sessions s
        LEFT JOIN session_reports r ON r.session_id = s.id AND r.deleted_at IS NULL
       WHERE s.deleted_at IS NULL AND s.session_date BETWEEN $1::date AND $2::date
       GROUP BY s.instructor_id
       ORDER BY s.instructor_id
    `, params);
    const payouts = await query(runner, `
      SELECT p.id,
             p.instructor_id AS "instructorId",
             p.period_start AS "periodStart",
             p.period_end AS "periodEnd",
             p.status,
             p.session_count AS "sessionCount",
             p.total_minutes AS "totalMinutes",
             p.computed_amount AS "computedAmount",
             p.adjusted_amount AS "adjustedAmount",
             p.amount,
             jsonb_array_length(p.lines::jsonb) AS "lineCount",
             COALESCE((SELECT SUM((line ->> 'amount')::bigint)
                         FROM jsonb_array_elements(p.lines::jsonb) line), 0)::bigint AS "lineAmount"
        FROM instructor_payouts p
       WHERE p.deleted_at IS NULL
         AND p.period_start <= $2::date
         AND p.period_end >= $1::date
       ORDER BY p.instructor_id, p.period_start, p.id
    `, params);
    const audit = await query(runner, `
      SELECT a.entity, a.action, COUNT(*)::int AS count
        FROM audit_log a
       WHERE (a.entity = 'class_sessions' AND EXISTS (
                SELECT 1 FROM class_sessions s
                 WHERE s.id = a.entity_id AND s.session_date BETWEEN $1::date AND $2::date
             ))
          OR (a.entity = 'instructor_payouts' AND EXISTS (
                SELECT 1 FROM instructor_payouts p
                 WHERE p.id = a.entity_id AND p.period_start <= $2::date AND p.period_end >= $1::date
             ))
       GROUP BY a.entity, a.action
       ORDER BY a.entity, a.action
    `, params);
    const [integrity] = await query<Record<string, string>>(runner, `
      SELECT
        (SELECT COUNT(*) FROM class_sessions s
          WHERE s.deleted_at IS NULL
            AND s.session_date BETWEEN $1::date AND $2::date
            AND s.status = 'held' AND s.instructor_attendance IS NULL)::text AS "heldWithoutInstructorAttendance",
        (SELECT COUNT(*) FROM class_sessions s
          WHERE s.deleted_at IS NULL
            AND s.session_date BETWEEN $1::date AND $2::date
            AND s.status = 'held'
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(s.student_ids::jsonb) participant
               WHERE NOT EXISTS (
                 SELECT 1 FROM attendance a
                  WHERE a.session_id = s.id AND a.student_id = participant::int AND a.deleted_at IS NULL
               )
            ))::text AS "heldWithMissingStudentAttendance",
        (SELECT COUNT(*) FROM class_sessions s
          WHERE s.deleted_at IS NULL
            AND s.session_date BETWEEN $1::date AND $2::date
            AND s.status = 'held'
            AND NOT EXISTS (
              SELECT 1 FROM session_reports r
               WHERE r.session_id = s.id AND r.deleted_at IS NULL AND r.approval_status = 'approved'
            ))::text AS "heldWithoutApprovedReport",
        (SELECT COUNT(*) FROM class_sessions s
          JOIN instructor_payouts p ON p.id = s.payout_id AND p.deleted_at IS NULL
         WHERE s.deleted_at IS NULL
           AND s.session_date BETWEEN $1::date AND $2::date
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(p.lines::jsonb) line
              WHERE (line ->> 'sessionId')::int = s.id
           ))::text AS "sessionPayoutLinkWithoutLine",
        (SELECT COUNT(*) FROM instructor_payouts p
         WHERE p.deleted_at IS NULL
           AND p.period_start <= $2::date AND p.period_end >= $1::date
           AND p.computed_amount <> COALESCE((
             SELECT SUM((line ->> 'amount')::bigint)
               FROM jsonb_array_elements(p.lines::jsonb) line
           ), 0))::text AS "payoutComputedAmountMismatch",
        (SELECT COUNT(*) FROM instructor_payouts p
         WHERE p.deleted_at IS NULL
           AND p.period_start <= $2::date AND p.period_end >= $1::date
           AND p.amount <> COALESCE(p.adjusted_amount, p.computed_amount))::text AS "payoutEffectiveAmountMismatch",
        (SELECT COUNT(*) FROM instructor_payouts p
         WHERE p.deleted_at IS NULL
           AND p.period_start <= $2::date AND p.period_end >= $1::date
           AND p.status = 'paid'
           AND (SELECT COUNT(*) FROM transactions t
                 WHERE t.deleted_at IS NULL AND t.payout_id = p.id
                   AND t.direction = 'out' AND t.category = 'instructor_payout') <> 1)::text AS "paidPayoutTransactionMismatch"
    `, params);
    await runner.commitTransaction();

    const measurements = Object.fromEntries(
      Object.entries(integrity).map(([key, value]) => [key, Number(value)]),
    );
    const { heldWithoutApprovedReport, ...hardIntegrity } = measurements;
    console.log(JSON.stringify({
      ok: Object.values(hardIntegrity).every((value) => value === 0),
      mode: 'read-only',
      range: { from: FROM, to: TO },
      database,
      sessions,
      reports,
      payouts,
      audit,
      readiness: { heldWithoutApprovedReport },
      integrity: hardIntegrity,
    }, null, 2));
    if (!Object.values(hardIntegrity).every((value) => value === 0)) process.exitCode = 2;
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
