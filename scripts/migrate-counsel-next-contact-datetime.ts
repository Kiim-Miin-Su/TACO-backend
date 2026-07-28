import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID,
  COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL,
} from '../src/database/migrations/counsel-next-contact-datetime.migration';

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
  const columns = await dataSource.query(
    `SELECT table_name, data_type
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name IN ('counsel_forms','counsel_rounds')
        AND column_name='next_contact_at'
      ORDER BY table_name`,
  );
  const [roundsTable] = await dataSource.query(
    `SELECT to_regclass('public.counsel_rounds') IS NOT NULL AS present`,
  );
  const legacySnapshots = roundsTable?.present
    ? await dataSource.query(
        `SELECT COUNT(*)::integer AS count FROM counsel_rounds
          WHERE jsonb_typeof(form_snapshot)='object'
            AND form_snapshot->>'nextContactAt' ~ '^\\d{4}-\\d{2}-\\d{2}$'`,
      )
    : [{ count: 0 }];
  const ledgerTable = await dataSource.query(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
  );
  const ledgerApplied = ledgerTable[0]?.present
    ? (
        await dataSource.query(
          'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
          [COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID],
        )
      )[0]?.applied === true
    : false;
  return {
    columns,
    legacySnapshotCount: legacySnapshots[0]?.count ?? 0,
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
          migration: COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID,
          current: await state(),
        },
        null,
        2,
      ),
    );
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [76, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query(
      'SELECT id FROM schema_migrations WHERE id=$1',
      [COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID],
    );
    if (applied.length) return;
    for (const sql of COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL) {
      await manager.query(sql);
    }
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [
      COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID,
    ]);
  });

  const after = await state();
  const columnTypes = new Map(
    (after.columns as Array<{ table_name: string; data_type: string }>).map(
      (row) => [row.table_name, row.data_type],
    ),
  );
  if (
    columnTypes.get('counsel_forms') !== 'timestamp with time zone' ||
    columnTypes.get('counsel_rounds') !== 'timestamp with time zone' ||
    after.legacySnapshotCount !== 0 ||
    after.ledgerApplied !== true
  ) {
    throw new Error('counsel next-contact datetime migration readback failed');
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        migration: COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID,
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
