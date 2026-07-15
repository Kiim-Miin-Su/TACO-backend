import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  SENS_PROVIDER_MIGRATION_ID,
  SENS_PROVIDER_MIGRATION_SQL,
} from '../src/database/migrations/sens-provider.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

// provider CHECK 정의 요약 — 이름이 아닌 정의로 판정(인라인 CHECK 자동 이름은 배포마다 다를 수 있음).
const CHECK_STATE_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'profile_verification_challenges'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%email_smtp%') AS provider_check_exists,
    EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'profile_verification_challenges'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%ncp_sens%') AS allows_ncp_sens`;

async function main(): Promise<void> {
  await dataSource.initialize();
  // 미존재 테이블 regclass 캐스팅은 실행 시 오류 — 존재 확인 후 2단계 조회(20260715_01 학습 재적용).
  const [reg] = await dataSource.query(
    `SELECT to_regclass('public.profile_verification_challenges') IS NOT NULL AS table_exists`,
  );
  if (!reg?.table_exists) {
    throw new Error('profile_verification_challenges 테이블이 없습니다 — 20260714_03 선행 적용을 확인하세요.');
  }
  const [current] = await dataSource.query(CHECK_STATE_SQL);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: SENS_PROVIDER_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 6]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [SENS_PROVIDER_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of SENS_PROVIDER_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [SENS_PROVIDER_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(CHECK_STATE_SQL);
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`,
    [SENS_PROVIDER_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: SENS_PROVIDER_MIGRATION_ID, after: { ...after, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
