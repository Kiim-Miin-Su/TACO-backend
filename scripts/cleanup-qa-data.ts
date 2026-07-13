import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();

const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();

if (!url) {
  console.error('DATABASE_URL_UNPOOLED, DATABASE_URL, POSTGRES_URL_NON_POOLING, or POSTGRES_URL is required for db:cleanup:qa');
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
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  extra: {
    max: Number(process.env.DB_POOL_MAX ?? 1),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
  },
});

const requestNoiseWhere = `
  deleted_at IS NULL
  AND (
    topic LIKE 'TBO-24-24C-%'
    OR topic LIKE 'TBO-23-A1A2-db-smoke-%'
    OR topic LIKE 'QA-rerender-%'
    OR request_reason LIKE '24C smoke:%'
    OR request_reason = 'A1/A2 DB persistence smoke'
    OR request_reason = 'browser QA immediate rerender check'
    OR session_date >= DATE '2099-01-01'
  )
`;

const sessionNoiseWhere = `
  deleted_at IS NULL
  AND id NOT IN (1, 2, 8)
  AND (
    topic LIKE 'TBO-24-24C-%'
    OR topic LIKE 'TBO-23-A1A2-db-smoke-%'
    OR topic LIKE 'QA-rerender-%'
    OR topic LIKE 'TBO-24-att-report-%'
    OR session_date >= DATE '2099-01-01'
  )
`;

const financePaymentWhere = `
  deleted_at IS NULL
  AND due_at >= DATE '2099-01-01'
`;

const financeExpenseWhere = `
  deleted_at IS NULL
  AND spent_at >= DATE '2099-01-01'
`;

const financePayoutWhere = `
  deleted_at IS NULL
  AND period_start >= DATE '2099-01-01'
`;

const seedRestores = [
  {
    id: 1,
    seriesId: 1,
    courseId: 10,
    instructorId: 1,
    roomId: 1,
    sessionDate: '2026-07-06',
    startTime: '16:00',
    endTime: '17:30',
    durationMinutes: 90,
    status: 'scheduled',
    kind: 'class',
    mode: 'in_person',
    topic: 'SAT Reading 정규',
  },
  {
    id: 2,
    seriesId: 1,
    courseId: 10,
    instructorId: 1,
    roomId: 1,
    sessionDate: '2026-07-08',
    startTime: '16:00',
    endTime: '17:30',
    durationMinutes: 90,
    status: 'scheduled',
    kind: 'class',
    mode: 'in_person',
    topic: 'SAT Reading 정규',
  },
  {
    id: 8,
    seriesId: null,
    courseId: 12,
    instructorId: 1,
    roomId: 2,
    sessionDate: '2026-07-06',
    startTime: '13:00',
    endTime: '14:00',
    durationMinutes: 60,
    status: 'scheduled',
    kind: 'class',
    mode: 'online',
    topic: 'TOEFL 정규 — 보강',
  },
];

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return dataSource.query(sql, params);
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${table}`]);
  return rows[0]?.exists === true;
}

async function countRows(): Promise<Record<string, unknown>> {
  const hasPayments = await tableExists('payments');
  const hasExpenses = await tableExists('expenses');
  const hasPayouts = await tableExists('instructor_payouts');
  const hasTransactions = await tableExists('transactions');
  const [requestByStatus, sessions, reports, attendance, audit] = await Promise.all([
    query(`SELECT status, count(*)::int AS count FROM schedule_requests WHERE ${requestNoiseWhere} GROUP BY status ORDER BY status`),
    query(`SELECT count(*)::int AS count FROM class_sessions WHERE ${sessionNoiseWhere}`),
    query(`
      SELECT count(*)::int AS count
      FROM session_reports
      WHERE deleted_at IS NULL
        AND session_id IN (SELECT id FROM class_sessions WHERE ${sessionNoiseWhere})
    `),
    query(`
      SELECT count(*)::int AS count
      FROM attendance
      WHERE deleted_at IS NULL
        AND session_id IN (SELECT id FROM class_sessions WHERE ${sessionNoiseWhere})
    `),
    query(`
      SELECT count(*)::int AS count
      FROM audit_log
      WHERE deleted_at IS NULL
        AND (
          (entity = 'schedule_requests' AND entity_id IN (SELECT id FROM schedule_requests WHERE ${requestNoiseWhere}))
          OR (entity = 'class_sessions' AND entity_id IN (SELECT id FROM class_sessions WHERE ${sessionNoiseWhere}))
        )
    `),
  ]);
  return {
    scheduleRequestsByStatus: requestByStatus,
    classSessions: sessions[0]?.count ?? 0,
    sessionReports: reports[0]?.count ?? 0,
    attendance: attendance[0]?.count ?? 0,
    auditLog: audit[0]?.count ?? 0,
    financePayments: hasPayments ? (await query<{ count: number }>(`SELECT count(*)::int AS count FROM payments WHERE ${financePaymentWhere}`))[0]?.count ?? 0 : 0,
    financeExpenses: hasExpenses ? (await query<{ count: number }>(`SELECT count(*)::int AS count FROM expenses WHERE ${financeExpenseWhere}`))[0]?.count ?? 0 : 0,
    financePayouts: hasPayouts ? (await query<{ count: number }>(`SELECT count(*)::int AS count FROM instructor_payouts WHERE ${financePayoutWhere}`))[0]?.count ?? 0 : 0,
    financeTransactions: hasTransactions && hasPayments && hasExpenses && hasPayouts ? (await query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM transactions
      WHERE deleted_at IS NULL
        AND (
          payment_id IN (SELECT id FROM payments WHERE ${financePaymentWhere})
          OR expense_id IN (SELECT id FROM expenses WHERE ${financeExpenseWhere})
          OR payout_id IN (SELECT id FROM instructor_payouts WHERE ${financePayoutWhere})
        )
    `))[0]?.count ?? 0 : 0,
  };
}

async function restoreSeedRows(): Promise<void> {
  for (const row of seedRestores) {
    await query(
      `
        UPDATE class_sessions
        SET
          series_id = $2,
          course_id = $3,
          instructor_id = $4,
          room_id = $5,
          session_date = $6,
          start_time = $7,
          end_time = $8,
          duration_minutes = $9,
          status = $10,
          kind = $11,
          mode = $12,
          topic = $13,
          memo = NULL,
          color = NULL,
          instructor_attendance = NULL,
          deleted_at = NULL,
          deleted_by = NULL,
          updated_at = now()
        WHERE id = $1
      `,
      [
        row.id,
        row.seriesId,
        row.courseId,
        row.instructorId,
        row.roomId,
        row.sessionDate,
        row.startTime,
        row.endTime,
        row.durationMinutes,
        row.status,
        row.kind,
        row.mode,
        row.topic,
      ],
    );
  }
}

async function applyCleanup(): Promise<Record<string, unknown>> {
  const hasPayments = await tableExists('payments');
  const hasExpenses = await tableExists('expenses');
  const hasPayouts = await tableExists('instructor_payouts');
  const hasTransactions = await tableExists('transactions');
  await dataSource.transaction(async (manager) => {
    await manager.query(`CREATE TEMP TABLE qa_cleanup_request_ids AS SELECT id FROM schedule_requests WHERE ${requestNoiseWhere}`);
    await manager.query(`CREATE TEMP TABLE qa_cleanup_session_ids AS SELECT id FROM class_sessions WHERE ${sessionNoiseWhere}`);
    if (hasPayments) {
      await manager.query(`CREATE TEMP TABLE qa_cleanup_payment_ids AS SELECT id FROM payments WHERE ${financePaymentWhere}`);
    }
    if (hasExpenses) {
      await manager.query(`CREATE TEMP TABLE qa_cleanup_expense_ids AS SELECT id FROM expenses WHERE ${financeExpenseWhere}`);
    }
    if (hasPayouts) {
      await manager.query(`CREATE TEMP TABLE qa_cleanup_payout_ids AS SELECT id FROM instructor_payouts WHERE ${financePayoutWhere}`);
    }

    await manager.query(`
      UPDATE audit_log
      SET deleted_at = now(), updated_at = now()
      WHERE deleted_at IS NULL
        AND (
          (entity = 'schedule_requests' AND entity_id IN (SELECT id FROM qa_cleanup_request_ids))
          OR (entity = 'class_sessions' AND entity_id IN (SELECT id FROM qa_cleanup_session_ids))
        )
    `);
    await manager.query(`
      UPDATE attendance
      SET deleted_at = now(), updated_at = now()
      WHERE deleted_at IS NULL
        AND session_id IN (SELECT id FROM qa_cleanup_session_ids)
    `);
    await manager.query(`
      UPDATE session_reports
      SET deleted_at = now(), updated_at = now()
      WHERE deleted_at IS NULL
        AND session_id IN (SELECT id FROM qa_cleanup_session_ids)
    `);
    await manager.query(`
      UPDATE schedule_requests
      SET deleted_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM qa_cleanup_request_ids)
        AND deleted_at IS NULL
    `);
    await manager.query(`
      UPDATE class_sessions
      SET deleted_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM qa_cleanup_session_ids)
        AND deleted_at IS NULL
    `);
    if (hasTransactions) {
      await manager.query(`
        UPDATE transactions
        SET deleted_at = now(), updated_at = now()
        WHERE deleted_at IS NULL
          AND (
            (${hasPayments ? 'payment_id IN (SELECT id FROM qa_cleanup_payment_ids)' : 'false'})
            OR (${hasExpenses ? 'expense_id IN (SELECT id FROM qa_cleanup_expense_ids)' : 'false'})
            OR (${hasPayouts ? 'payout_id IN (SELECT id FROM qa_cleanup_payout_ids)' : 'false'})
          )
      `);
    }
    if (hasPayments) {
      await manager.query(`
        UPDATE payments
        SET deleted_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM qa_cleanup_payment_ids)
          AND deleted_at IS NULL
      `);
    }
    if (hasExpenses) {
      await manager.query(`
        UPDATE expenses
        SET deleted_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM qa_cleanup_expense_ids)
          AND deleted_at IS NULL
      `);
    }
    if (hasPayouts) {
      await manager.query(`
        UPDATE instructor_payouts
        SET deleted_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM qa_cleanup_payout_ids)
          AND deleted_at IS NULL
      `);
    }
  });
  await restoreSeedRows();
  return countRows();
}

async function main() {
  await dataSource.initialize();
  const before = await countRows();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', applyHint: 'APPLY=1 npm run db:cleanup:qa', before }, null, 2));
    return;
  }
  const after = await applyCleanup();
  console.log(JSON.stringify({ ok: true, mode: 'applied', before, after }, null, 2));
}

main()
  .catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
