import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  CREDENTIAL_OTP_MIGRATION_ID,
  CREDENTIAL_OTP_MIGRATION_SQL,
} from '../src/database/migrations/credential-otp.migration';

// [E0] 비밀번호 변경 OTP state CHECK — dry-run 기본, APPLY=1일 때만 적용(멱등).
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
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profile_verification_state_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%consumed_by_request_id IS NOT NULL%'
  ) AS state_check_allows_credential_consume`;

async function main(): Promise<void> {
  await dataSource.initialize();
  const [current] = await dataSource.query(STATE_SQL);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: CREDENTIAL_OTP_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 14]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [CREDENTIAL_OTP_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of CREDENTIAL_OTP_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [CREDENTIAL_OTP_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(STATE_SQL);
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [CREDENTIAL_OTP_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: CREDENTIAL_OTP_MIGRATION_ID, after: { ...after, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
