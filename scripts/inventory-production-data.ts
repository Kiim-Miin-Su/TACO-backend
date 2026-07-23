import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource, QueryRunner } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();

type TableColumn = { table_name: string; column_name: string };
type TableCount = { table: string; total: number; active: number; deleted: number };

const url = directDatabaseUrl();

if (!url) {
  console.error('DATABASE_URL_UNPOOLED, DATABASE_URL, POSTGRES_URL_NON_POOLING, or POSTGRES_URL is required for db:inventory');
  process.exit(1);
}

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const quoteIdentifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
};

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
    const columns = await query<TableColumn>(runner, `
      SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.ordinal_position
    `);
    const columnsByTable = new Map<string, Set<string>>();
    for (const column of columns) {
      const owned = columnsByTable.get(column.table_name) ?? new Set<string>();
      owned.add(column.column_name);
      columnsByTable.set(column.table_name, owned);
    }

    const tableCounts: TableCount[] = [];
    for (const [table, tableColumns] of columnsByTable) {
      const relation = quoteIdentifier(table);
      const hasSoftDelete = tableColumns.has('deleted_at');
      const [count] = await query<{ total: string; active: string; deleted: string }>(runner, `
        SELECT COUNT(*)::bigint AS total,
               ${hasSoftDelete ? 'COUNT(*) FILTER (WHERE deleted_at IS NULL)' : 'COUNT(*)'}::bigint AS active,
               ${hasSoftDelete ? 'COUNT(*) FILTER (WHERE deleted_at IS NOT NULL)' : '0'}::bigint AS deleted
          FROM ${relation}
      `);
      tableCounts.push({
        table,
        total: Number(count.total),
        active: Number(count.active),
        deleted: Number(count.deleted),
      });
    }

    const accounts = await query(runner, `
      SELECT id, web_id AS "webId", name, role, status, email_verified AS "emailVerified",
             last_login_at AS "lastLoginAt", created_at AS "createdAt", deleted_at AS "deletedAt"
        FROM users
       ORDER BY id
    `);
    const accountGroups = await query(runner, `
      SELECT role, status, (deleted_at IS NULL) AS active, COUNT(*)::int AS count
        FROM users
       GROUP BY role, status, (deleted_at IS NULL)
       ORDER BY role, status, active DESC
    `);
    const students = await query(runner, `
      SELECT id, name, status, birth_date AS "birthDate", created_at AS "createdAt", deleted_at AS "deletedAt"
        FROM students
       ORDER BY id
    `);
    const parents = await query(runner, `
      SELECT id, name, created_at AS "createdAt", deleted_at AS "deletedAt"
        FROM parents
       ORDER BY id
    `);
    const catalog = {
      subjects: await query(runner, `SELECT id, code, name, deleted_at AS "deletedAt" FROM subjects ORDER BY id`),
      courses: await query(runner, `SELECT id, code, name, status, instructor_id AS "instructorId", deleted_at AS "deletedAt" FROM courses ORDER BY id`),
      rooms: await query(runner, `SELECT id, name, is_active AS "isActive", deleted_at AS "deletedAt" FROM rooms ORDER BY id`),
      countries: await query(runner, `SELECT COUNT(*)::int AS count FROM countries WHERE deleted_at IS NULL`),
      reportTemplates: await query(runner, `SELECT id, name, created_at AS "createdAt", deleted_at AS "deletedAt" FROM report_templates ORDER BY id`),
    };
    const softDeletedDetails = {
      availabilityBlocks: await query(runner, `
        SELECT id, owner_type AS "ownerType", owner_id AS "ownerId", kind, deleted_at AS "deletedAt"
          FROM availability_blocks WHERE deleted_at IS NOT NULL ORDER BY id
      `),
      calendarViewPresets: await query(runner, `
        SELECT id, name, deleted_at AS "deletedAt" FROM calendar_view_presets WHERE deleted_at IS NOT NULL ORDER BY id
      `),
      classSessions: await query(runner, `
        SELECT id, course_id AS "courseId", instructor_id AS "instructorId", topic,
               session_date AS "sessionDate", deleted_at AS "deletedAt"
          FROM class_sessions WHERE deleted_at IS NOT NULL ORDER BY id
      `),
      counselForms: await query(runner, `
        SELECT id, student_id AS "studentId", assigned_staff_id AS "assignedStaffId", status, deleted_at AS "deletedAt"
          FROM counsel_forms WHERE deleted_at IS NOT NULL ORDER BY id
      `),
      counselRounds: await query(runner, `
        SELECT id, counsel_form_id AS "counselFormId", round_no AS "roundNo", deleted_at AS "deletedAt"
          FROM counsel_rounds WHERE deleted_at IS NOT NULL ORDER BY id
      `),
      instructorProfiles: await query(runner, `
        SELECT user_id AS "userId", deleted_at AS "deletedAt"
          FROM instructor_profiles WHERE deleted_at IS NOT NULL ORDER BY user_id
      `),
      studentAcademicHistories: await query(runner, `
        SELECT id, student_id AS "studentId", deleted_at AS "deletedAt"
          FROM student_academic_histories WHERE deleted_at IS NOT NULL ORDER BY id
      `),
      studentFamilyRelations: await query(runner, `
        SELECT id, student_id_a AS "studentIdA", student_id_b AS "studentIdB", deleted_at AS "deletedAt"
          FROM student_family_relations WHERE deleted_at IS NOT NULL ORDER BY id
      `),
      studentInterests: await query(runner, `
        SELECT id, student_id AS "studentId", course_id AS "courseId", custom_label AS "customLabel", deleted_at AS "deletedAt"
          FROM student_interests WHERE deleted_at IS NOT NULL ORDER BY id
      `),
    };
    const operationalSummaries = {
      sessions: await query(runner, `
        SELECT status, kind, COUNT(*)::int AS count, MIN(session_date) AS "firstDate", MAX(session_date) AS "lastDate"
          FROM class_sessions
         WHERE deleted_at IS NULL
         GROUP BY status, kind
         ORDER BY status, kind
      `),
      counsel: await query(runner, `
        SELECT status, COUNT(*)::int AS count
          FROM counsel_forms
         WHERE deleted_at IS NULL
         GROUP BY status
         ORDER BY status
      `),
      payouts: await query(runner, `
        SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::bigint AS amount
          FROM instructor_payouts
         WHERE deleted_at IS NULL
         GROUP BY status
         ORDER BY status
      `),
      audit: await query(runner, `
        SELECT entity, action, COUNT(*)::int AS count
          FROM audit_log
         GROUP BY entity, action
         ORDER BY entity, action
      `),
      authEvents: await query(runner, `
        SELECT event_type AS "eventType", success, COUNT(*)::int AS count
          FROM auth_events
         GROUP BY event_type, success
         ORDER BY event_type, success
      `),
      auditActors: await query(runner, `
        SELECT a.actor_id AS "actorId", u.web_id AS "actorWebId", COUNT(*)::int AS count
          FROM audit_log a
          LEFT JOIN users u ON u.id = a.actor_id
         GROUP BY a.actor_id, u.web_id
         ORDER BY count DESC, a.actor_id
      `),
    };
    const cleanupCandidates = await query(runner, `
      SELECT 'class_sessions' AS table_name, id,
             COALESCE(topic, '') AS label,
             CASE WHEN session_date >= DATE '2099-01-01' THEN 'future-sentinel-date' ELSE 'qa-marker' END AS reason
        FROM class_sessions
       WHERE deleted_at IS NULL
         AND (session_date >= DATE '2099-01-01' OR COALESCE(topic, '') ~* '(TBO-|QA-|DB[ -]?CRUD|DB-REFRESH|demo|test)')
      UNION ALL
      SELECT 'schedule_requests', id, COALESCE(topic, request_reason, ''),
             CASE WHEN session_date >= DATE '2099-01-01' THEN 'future-sentinel-date' ELSE 'qa-marker' END
        FROM schedule_requests
       WHERE deleted_at IS NULL
         AND (session_date >= DATE '2099-01-01' OR COALESCE(topic, '') ~* '(TBO-|QA-|DB[ -]?CRUD|DB-REFRESH|demo|test)'
              OR COALESCE(request_reason, '') ~* '(TBO-|QA-|DB[ -]?CRUD|DB-REFRESH|demo|test|smoke)')
      UNION ALL
      SELECT 'students', id, name, 'qa-marker'
        FROM students
       WHERE deleted_at IS NULL AND name ~* '(TBO-|QA-|DB[ -]?CRUD|DB-REFRESH|demo|test)'
      UNION ALL
      SELECT 'parents', id, name, 'qa-marker'
        FROM parents
       WHERE deleted_at IS NULL AND name ~* '(TBO-|QA-|DB[ -]?CRUD|DB-REFRESH|demo|test)'
      UNION ALL
      SELECT 'users', id, web_id, 'qa-marker'
        FROM users
       WHERE deleted_at IS NULL AND (web_id ~* '(TBO-|QA-|DB[ -]?CRUD|DB-REFRESH|demo|test)'
              OR name ~* '(TBO-|QA-|DB[ -]?CRUD|DB-REFRESH|demo|test)')
      UNION ALL
      SELECT 'payments', id, COALESCE(memo, ''), 'future-sentinel-date'
        FROM payments
       WHERE deleted_at IS NULL AND due_at >= DATE '2099-01-01'
      UNION ALL
      SELECT 'expenses', id, COALESCE(title, ''), 'future-sentinel-date'
        FROM expenses
       WHERE deleted_at IS NULL AND spent_at >= DATE '2099-01-01'
      UNION ALL
      SELECT 'instructor_payouts', id, COALESCE(memo, ''), 'future-sentinel-date'
        FROM instructor_payouts
       WHERE deleted_at IS NULL AND period_start >= DATE '2099-01-01'
      ORDER BY table_name, id
    `);
    const database = await query<{ database: string; serverVersion: string; checkedAt: string }>(runner, `
      SELECT current_database() AS database,
             current_setting('server_version') AS "serverVersion",
             now()::text AS "checkedAt"
    `);

    await runner.commitTransaction();
    console.log(JSON.stringify({
      ok: true,
      mode: 'read-only',
      database: database[0],
      tableCounts,
      totals: {
        physicalTables: tableCounts.length,
        populatedTables: tableCounts.filter((row) => row.total > 0).length,
        emptyTables: tableCounts.filter((row) => row.total === 0).length,
        activeRows: tableCounts.reduce((sum, row) => sum + row.active, 0),
        softDeletedRows: tableCounts.reduce((sum, row) => sum + row.deleted, 0),
      },
      accountGroups,
      accounts,
      students,
      parents,
      catalog,
      softDeletedDetails,
      operationalSummaries,
      cleanupCandidates,
    }, null, 2));
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
