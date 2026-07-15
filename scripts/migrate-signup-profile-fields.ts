import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  SIGNUP_PROFILE_FIELDS_MIGRATION_ID,
  SIGNUP_PROFILE_FIELDS_MIGRATION_SQL,
} from '../src/database/migrations/signup-profile-fields.migration';

// [E0.5 ④b] users 가입 필드(대학·전공·출생연도) — dry-run 기본, APPLY=1일 때만 적용(멱등).
loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const STATE_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='university') AS university,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='major') AS major,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='birth_year') AS birth_year`;

async function main(): Promise<void> {
  await dataSource.initialize();
  const [current] = await dataSource.query(STATE_SQL);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: SIGNUP_PROFILE_FIELDS_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 11]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [SIGNUP_PROFILE_FIELDS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of SIGNUP_PROFILE_FIELDS_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [SIGNUP_PROFILE_FIELDS_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(STATE_SQL);
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [SIGNUP_PROFILE_FIELDS_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: SIGNUP_PROFILE_FIELDS_MIGRATION_ID, after: { ...after, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
