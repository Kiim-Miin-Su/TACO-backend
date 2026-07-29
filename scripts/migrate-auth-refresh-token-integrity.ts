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
    `SELECT conname, contype, convalidated, pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint
      WHERE conrelid='public.auth_refresh_tokens'::regclass
        AND conname = ANY($1)
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

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  let alreadyApplied = false;
  try {
    // ADD NOT VALID와 VALIDATE 사이에도 다른 migration runner가 끼어들지 않도록
    // 같은 물리 connection의 session advisory lock을 유지한다.
    await runner.query('SELECT pg_advisory_lock($1, $2)', [76, 8]);
    await runner.startTransaction();
    try {
      await runner.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        id varchar(100) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = await runner.query('SELECT id FROM schema_migrations WHERE id=$1', [
        AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
      ]);
      alreadyApplied = applied.length > 0;
      if (!alreadyApplied) {
        // Gate + ADD NOT VALID + replacement index. VALIDATE 전 commit하여 ADD가 취득한
        // 강한 lock을 먼저 해제한다.
        await runner.query(AUTH_REFRESH_TOKEN_INTEGRITY_SQL[0]);
        await runner.query(AUTH_REFRESH_TOKEN_INTEGRITY_SQL[1]);
        await runner.query(AUTH_REFRESH_TOKEN_INTEGRITY_SQL[3]);
      }
      await runner.commitTransaction();
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }

    if (!alreadyApplied) {
      await runner.startTransaction();
      try {
        await runner.query(AUTH_REFRESH_TOKEN_INTEGRITY_SQL[2]);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }

      const beforeLedger = await state();
      const validated = beforeLedger.constraints as Array<{ convalidated: boolean }>;
      if (
        validated.length !== AUTH_REFRESH_TOKEN_CONSTRAINTS.length ||
        !validated.every((constraint) => constraint.convalidated === true) ||
        beforeLedger.replacementIndexPresent !== true
      ) {
        throw new Error('auth refresh token constraints validation readback failed');
      }

      await runner.startTransaction();
      try {
        await runner.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
          AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
        ]);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
    }
  } finally {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    try {
      await runner.query('SELECT pg_advisory_unlock($1, $2)', [76, 8]);
    } finally {
      await runner.release();
    }
  }

  const after = await state();
  const constraints = after.constraints as Array<{
    conname: string;
    contype: string;
    convalidated: boolean;
    definition: string;
  }>;
  const expectedDefinitions: Record<string, { contype: string; includes: string[] }> = {
    fk_auth_refresh_user: {
      contype: 'f',
      includes: ['FOREIGN KEY (user_id)', 'REFERENCES users(id)'],
    },
    fk_auth_refresh_replaced_by: {
      contype: 'f',
      includes: [
        'FOREIGN KEY (replaced_by_id)',
        'REFERENCES auth_refresh_tokens(id)',
      ],
    },
    c_auth_refresh_not_self_replaced: {
      contype: 'c',
      includes: ['replaced_by_id IS NULL', 'replaced_by_id <> id'],
    },
    c_auth_refresh_expiry_after_create: {
      contype: 'c',
      includes: ['expires_at > created_at'],
    },
  };
  const allConstraintsValid =
    constraints.length === AUTH_REFRESH_TOKEN_CONSTRAINTS.length &&
    constraints.every((constraint) => {
      const expected = expectedDefinitions[constraint.conname];
      return (
        constraint.convalidated === true &&
        expected?.contype === constraint.contype &&
        expected.includes.every((part) => constraint.definition.includes(part))
      );
    });
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
