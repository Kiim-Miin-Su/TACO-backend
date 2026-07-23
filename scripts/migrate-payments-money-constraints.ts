// [TBO-53 C1 2026-07-23] payments/transactions FK·CHECK 적용 — dry-run 기본, APPLY=1로 실행.
import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID,
  PAYMENTS_MONEY_CONSTRAINTS_LEDGER_SQL,
} from '../src/database/migrations/payments-money-constraints.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const CONSTRAINTS = [
  'fk_payments_student', 'fk_payments_enrollment', 'fk_payments_payer_parent',
  'c_payments_amount_nonneg', 'c_payments_paid_amount_nonneg', 'c_payments_status_enum',
  'fk_transactions_payment',
] as const;

async function state(): Promise<Record<string, unknown>> {
  const rows = await dataSource.query(
    `SELECT conname FROM pg_constraint WHERE conname = ANY($1)`, [[...CONSTRAINTS]],
  );
  const present = new Set(rows.map((r: { conname: string }) => r.conname));
  const [tables] = await dataSource.query(`SELECT
    to_regclass('public.payments') IS NOT NULL AS payments,
    to_regclass('public.students') IS NOT NULL AS students,
    to_regclass('public.enrollments') IS NOT NULL AS enrollments,
    to_regclass('public.parents') IS NOT NULL AS parents,
    to_regclass('public.transactions') IS NOT NULL AS transactions`);
  const orphans = (tables.payments && tables.students && tables.enrollments && tables.parents && tables.transactions)
    ? (await dataSource.query(`SELECT
        (SELECT COUNT(*)::int FROM payments p LEFT JOIN students s ON s.id = p.student_id
          WHERE p.student_id IS NOT NULL AND s.id IS NULL) AS student_orphans,
        (SELECT COUNT(*)::int FROM payments p LEFT JOIN enrollments e ON e.id = p.enrollment_id
          WHERE p.enrollment_id IS NOT NULL AND e.id IS NULL) AS enrollment_orphans,
        (SELECT COUNT(*)::int FROM payments p LEFT JOIN parents g ON g.id = p.payer_parent_id
          WHERE p.payer_parent_id IS NOT NULL AND g.id IS NULL) AS parent_orphans,
        (SELECT COUNT(*)::int FROM transactions t LEFT JOIN payments p ON p.id = t.payment_id
          WHERE t.payment_id IS NOT NULL AND p.id IS NULL) AS tx_orphans`))[0]
    : { note: 'tables missing — 부팅/마이그레이션으로 표 생성 후 재실행', tables };
  let ledgerApplied = false;
  const [ledger] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations') AS present`,
  );
  if (ledger.present) {
    const [row] = await dataSource.query('SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied', [PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID]);
    ledgerApplied = row.applied === true;
  }
  return {
    constraints: Object.fromEntries(CONSTRAINTS.map((name) => [name, present.has(name)])),
    orphans,
    ledgerApplied,
  };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID, current: await state() }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [48, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of PAYMENTS_MONEY_CONSTRAINTS_LEDGER_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID]);
  });
  const after = await state();
  const allPresent = Object.values(after.constraints as Record<string, boolean>).every(Boolean);
  if (!allPresent || !after.ledgerApplied) throw new Error('payments money constraints migration readback failed');
  console.log(JSON.stringify({ ok: true, migration: PAYMENTS_MONEY_CONSTRAINTS_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
