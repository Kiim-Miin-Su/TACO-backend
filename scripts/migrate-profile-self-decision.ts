import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  PROFILE_SELF_DECISION_MIGRATION_ID,
  PROFILE_SELF_DECISION_MIGRATION_SQL,
} from '../src/database/migrations/profile-self-decision.migration';

// [E0.5 ①] 자기 결정 금지 CHECK → super_admin 예외 트리거 — dry-run 기본, APPLY=1일 때만 적용(멱등).
loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const STATE_SQL = `
  SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='profile_change_no_self_decision_check') AS old_check,
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_profile_change_self_decision') AS guard_trigger`;

async function main(): Promise<void> {
  await dataSource.initialize();
  const [current] = await dataSource.query(STATE_SQL);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: PROFILE_SELF_DECISION_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 12]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [PROFILE_SELF_DECISION_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of PROFILE_SELF_DECISION_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [PROFILE_SELF_DECISION_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(STATE_SQL);
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [PROFILE_SELF_DECISION_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: PROFILE_SELF_DECISION_MIGRATION_ID, after: { ...after, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
