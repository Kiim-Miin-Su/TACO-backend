import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  CLASS_SESSION_SERIES_MIGRATION_ID,
  CLASS_SESSION_SERIES_MIGRATION_SQL,
} from '../src/database/migrations/class-session-series.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function main(): Promise<void> {
  await dataSource.initialize();
  // [버그수정 2026-07-15] 미존재 테이블을 서브쿼리로 참조하면 to_regclass 가드와 무관하게
  //  **파스 시점**에 relation does not exist — 존재 확인 후 2단계로 조회한다(첫 dry-run 실패 원인).
  const [reg] = await dataSource.query(
    `SELECT to_regclass('public.class_session_series') IS NOT NULL AS table_exists,
            to_regclass('public.class_sessions') IS NOT NULL AS sessions_exists,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_class_sessions_series') AS sessions_series_fk`,
  );
  if (!reg?.sessions_exists) throw new Error('class_sessions 테이블이 없습니다 — 대상 DB를 확인하세요(앱 부팅/기존 migration 선행).');
  const [ids] = await dataSource.query(
    `SELECT COUNT(DISTINCT series_id) AS n FROM class_sessions WHERE series_id IS NOT NULL`,
  );
  const orphanRows = reg?.table_exists
    ? (await dataSource.query(
        `SELECT COUNT(*) AS n FROM class_sessions s WHERE s.series_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM class_session_series cs WHERE cs.id = s.series_id)`,
      ))[0]?.n
    : null;
  const current = { class_session_series: reg?.table_exists ?? false, sessions_series_fk: reg?.sessions_series_fk ?? false, distinct_series_ids: ids?.n, orphan_rows: orphanRows };
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: CLASS_SESSION_SERIES_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 4]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [CLASS_SESSION_SERIES_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of CLASS_SESSION_SERIES_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [CLASS_SESSION_SERIES_MIGRATION_ID]);
  });
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied,
            to_regclass('public.class_session_series') IS NOT NULL AS class_session_series,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_class_sessions_series') AS sessions_series_fk,
            (SELECT COUNT(*) FROM class_session_series) AS series_rows,
            (SELECT COUNT(*) FROM class_sessions s WHERE s.series_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM class_session_series cs WHERE cs.id = s.series_id)) AS orphan_rows`,
    [CLASS_SESSION_SERIES_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: CLASS_SESSION_SERIES_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
