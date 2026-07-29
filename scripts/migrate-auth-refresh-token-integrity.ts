import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  AUTH_REFRESH_TOKEN_CONSTRAINTS,
  AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
  AUTH_REFRESH_TOKEN_INTEGRITY_SQL,
} from '../src/database/migrations/auth-refresh-token-integrity.migration';

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
  const constraints = await dataSource.query(
    `SELECT conname, contype, convalidated
       FROM pg_constraint
      WHERE conname = ANY($1)
      ORDER BY conname`,
    [[...AUTH_REFRESH_TOKEN_CONSTRAINTS]],
  );
  const [index] = await dataSource.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND indexname='idx_auth_refresh_tokens_replaced_by'
     ) AS present`,
  );
  const [ledgerTable] = await dataSource.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  const ledgerApplied = ledgerTable.present
    ? (
        await dataSource.query(
          'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
          [AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID],
        )
      )[0].applied === true
    : false;
  return {
    constraints,
    replacementIndexPresent: index.present === true,
    ledgerApplied,
  };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: true,
          migration: AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
          current: await state(),
        },
        null,
        2,
      ),
    );
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [76, 8]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [
      AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
    ]);
    if (applied.length) return;
    for (const sql of AUTH_REFRESH_TOKEN_INTEGRITY_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
      AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
    ]);
  });

  const after = await state();
  const constraints = after.constraints as Array<{
    conname: string;
    convalidated: boolean;
  }>;
  const allConstraintsValid =
    constraints.length === AUTH_REFRESH_TOKEN_CONSTRAINTS.length &&
    constraints.every((constraint) => constraint.convalidated === true);
  if (
    !allConstraintsValid ||
    after.replacementIndexPresent !== true ||
    after.ledgerApplied !== true
  ) {
    throw new Error('auth refresh token integrity migration readback failed');
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        migration: AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
        after,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

