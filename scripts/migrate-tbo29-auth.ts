import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { TBO29_AUTH_MIGRATION_ID, TBO29_AUTH_MIGRATION_SQL } from '../src/database/migrations/tbo29-auth.migration';

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
  const existing = await dataSource.query(
    `SELECT to_regclass('public.instructor_profiles') AS instructor_profiles,
            to_regclass('public.auth_events') AS auth_events,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='must_change_password') AS must_change_password`,
  );
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: TBO29_AUTH_MIGRATION_ID, current: existing[0] }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [TBO29_AUTH_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of TBO29_AUTH_MIGRATION_SQL) await manager.query(sql);
    await manager.query('ALTER TABLE users VALIDATE CONSTRAINT users_role_check');
    await manager.query('ALTER TABLE users VALIDATE CONSTRAINT users_status_check');
    await manager.query('ALTER TABLE users VALIDATE CONSTRAINT users_approved_by_fkey');
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [TBO29_AUTH_MIGRATION_ID]);
  });
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied,
            to_regclass('public.instructor_profiles') IS NOT NULL AS instructor_profiles,
            to_regclass('public.auth_events') IS NOT NULL AS auth_events,
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='must_change_password') AS must_change_password,
            NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='email_verify_token') AS plaintext_token_removed`,
    [TBO29_AUTH_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: TBO29_AUTH_MIGRATION_ID, after }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
