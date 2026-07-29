import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID,
  SESSION_REPORT_PROGRESS_PAGE_MIGRATION_SQL,
} from '../src/database/migrations/session-report-progress-page.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: resolvePgSsl(),
  extra: {
    max: 1,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
  },
});

async function state(): Promise<Record<string, unknown>> {
  const [column] = await dataSource.query(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='session_reports'
        AND column_name='progress_page'`,
  );
  const [ledgerTable] = await dataSource.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  const ledgerApplied = ledgerTable?.present
    ? (
        await dataSource.query(
          'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
          [SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID],
        )
      )[0]?.applied === true
    : false;
  return {
    column: column ?? null,
    ledgerApplied,
  };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID,
      current: await state(),
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [76, 4]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query(
      'SELECT id FROM schema_migrations WHERE id=$1',
      [SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID],
    );
    if (applied.length) return;
    for (const sql of SESSION_REPORT_PROGRESS_PAGE_MIGRATION_SQL) {
      await manager.query(sql);
    }
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
      SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID,
    ]);
  });

  const after = await state();
  const column = after.column as { data_type?: string; is_nullable?: string } | null;
  if (
    column?.data_type !== 'text' ||
    column.is_nullable !== 'YES' ||
    after.ledgerApplied !== true
  ) {
    throw new Error('session report progress_page migration readback failed');
  }
  console.log(JSON.stringify({
    ok: true,
    migration: SESSION_REPORT_PROGRESS_PAGE_MIGRATION_ID,
    after,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
