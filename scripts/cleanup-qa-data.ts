import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
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
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
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

// [TBO-59 2026-07-24] 만료 챌린지 하드 삭제(PII 최소화 — phone/email 원문 보유 표).
//  미소비(pending/verified/expired/locked) + 만료 7일 경과만 — consumed는 가입·변경 증빙으로 보존.
//  QA·테스트가 남긴 인증 시도 레코드도 이 조건으로 함께 정리된다.
const CHALLENGE_TABLES = ['signup_phone_challenges', 'signup_email_challenges', 'profile_verification_challenges'] as const;
const staleChallengeWhere = `
  status <> 'consumed'
  AND expires_at < now() - interval '7 days'
`;
// 레이트리밋 창 종료 + 차단 해제 1일 경과 행 — 순수 만료 상태 키(개인 식별자 hash) 정리.
const staleRateLimitWhere = `
  window_expires_at < now() - interval '1 day'
  AND (blocked_until IS NULL OR blocked_until < now())
`;

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
    staleChallenges: Object.fromEntries(await Promise.all(CHALLENGE_TABLES.map(async (table) =>
      [table, (await tableExists(table)) ? (await query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE ${staleChallengeWhere}`))[0]?.count ?? 0 : 0] as const))),
    staleRateLimits: (await tableExists('auth_rate_limits')) ? (await query<{ count: number }>(`SELECT count(*)::int AS count FROM auth_rate_limits WHERE ${staleRateLimitWhere}`))[0]?.count ?? 0 : 0,
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
    // [TBO-59] 만료 챌린지·레이트리밋 = 하드 DELETE(soft-delete 아님 — PII 최소화 목적이라 원문 제거가 목표).
    for (const table of CHALLENGE_TABLES) {
      const rows = await manager.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${table}`]);
      if (rows[0]?.exists === true) await manager.query(`DELETE FROM ${table} WHERE ${staleChallengeWhere}`);
    }
    const rateLimitExists = await manager.query(`SELECT to_regclass('public.auth_rate_limits') IS NOT NULL AS exists`);
    if (rateLimitExists[0]?.exists === true) await manager.query(`DELETE FROM auth_rate_limits WHERE ${staleRateLimitWhere}`);
  });
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
