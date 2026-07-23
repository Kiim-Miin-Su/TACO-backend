import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  AUTH_RATE_LIMITS_MIGRATION_ID,
  AUTH_RATE_LIMITS_MIGRATION_SQL,
} from '../src/database/migrations/auth-rate-limits.migration';

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
  const [current] = await dataSource.query(
    `SELECT to_regclass('public.auth_rate_limits') IS NOT NULL AS auth_rate_limits,
            EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_auth_rate_limits_expiry') AS expiry_index`,
  );
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: AUTH_RATE_LIMITS_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [34, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [AUTH_RATE_LIMITS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of AUTH_RATE_LIMITS_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [AUTH_RATE_LIMITS_MIGRATION_ID]);
  });
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied,
            to_regclass('public.auth_rate_limits') IS NOT NULL AS auth_rate_limits`,
    [AUTH_RATE_LIMITS_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: AUTH_RATE_LIMITS_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
