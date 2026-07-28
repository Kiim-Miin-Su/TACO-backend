// [74D-1 2026-07-28] attendance/session_reports FK·CHECK·인덱스 적용 — dry-run 기본, APPLY=1로 실행.
//  운영 절차는 RUNBOOK-BACKUP-MONITORING §14(74D-1): ① 인벤토리(db:inventory:attendance-reports) 0 확인
//  ② dry-run(사전 orphan 게이트 재확인) ③ Neon 스냅샷 ④ APPLY=1 ⑤ readback(convalidated 전부 true).
import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID,
  ATTENDANCE_REPORTS_CONSTRAINTS_LEDGER_SQL,
} from '../src/database/migrations/attendance-reports-constraints.migration';

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
  'fk_attendance_session', 'fk_attendance_student', 'c_attendance_status_enum',
  'fk_reports_session', 'fk_reports_student', 'fk_reports_instructor',
  'fk_reports_approved_by', 'fk_reports_subject',
  'c_reports_status_enum', 'c_reports_approval_status_enum',
] as const;

async function state(): Promise<Record<string, unknown>> {
  const rows = await dataSource.query(
    `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1)`, [[...CONSTRAINTS]],
  );
  const present = new Map<string, boolean>(rows.map((r: { conname: string; convalidated: boolean }) => [r.conname, r.convalidated]));
  const [idx] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_reports_student') AS present`,
  );
  let ledgerApplied = false;
  const [ledger] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='schema_migrations') AS present`,
  );
  if (ledger.present) {
    const [row] = await dataSource.query('SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied', [ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID]);
    ledgerApplied = row.applied === true;
  }
  return {
    constraints: Object.fromEntries(CONSTRAINTS.map((name) => [name,
      present.has(name) ? { present: true, convalidated: present.get(name) } : { present: false }])),
    idxReportsStudent: idx.present,
    ledgerApplied,
  };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID, current: await state() }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [48, 3]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of ATTENDANCE_REPORTS_CONSTRAINTS_LEDGER_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID]);
  });
  const after = await state();
  const allValid = Object.values(after.constraints as Record<string, { present: boolean; convalidated?: boolean }>)
    .every((c) => c.present && c.convalidated === true);
  if (!allValid || !after.ledgerApplied || after.idxReportsStudent !== true) {
    throw new Error('attendance/reports constraints migration readback failed');
  }
  console.log(JSON.stringify({ ok: true, migration: ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
