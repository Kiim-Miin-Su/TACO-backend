import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { resolvePgSsl } from '../src/database/pg-ssl';
import {
  SCHEMA_SHAPE_CHECKS,
  SCHEMA_SHAPE_FOREIGN_KEYS,
  SCHEMA_SHAPE_INTEGRITY_MIGRATION_ID,
  SCHEMA_SHAPE_INTEGRITY_SQL,
} from '../src/database/migrations/schema-shape-integrity.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('A direct database URL is required');

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function readback(executor: Pick<DataSource, 'query'> = dataSource) {
  const expectedNames = [
    ...SCHEMA_SHAPE_CHECKS.map((spec) => spec.name),
    ...SCHEMA_SHAPE_FOREIGN_KEYS.map((spec) => spec.name),
  ];
  const rows = await executor.query(
    `SELECT conname, convalidated
       FROM pg_constraint
      WHERE conname = ANY($1::text[])
      ORDER BY conname`,
    [expectedNames],
  ) as Array<{ conname: string; convalidated: boolean }>;
  const [defaultRow] = await executor.query(
    `SELECT column_default
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name='academy_events' AND column_name='type'`,
  ) as Array<{ column_default: string | null }>;
  const [ledger] = await executor.query(
    'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
    [SCHEMA_SHAPE_INTEGRITY_MIGRATION_ID],
  );
  return {
    expectedConstraints: expectedNames.length,
    presentConstraints: rows.length,
    invalidConstraints: rows.filter((row) => !row.convalidated).map((row) => row.conname),
    eventTypeDefault: defaultRow?.column_default ?? null,
    ledgerApplied: ledger?.applied === true,
  };
}

const complete = (state: Awaited<ReturnType<typeof readback>>): boolean =>
  state.presentConstraints === state.expectedConstraints
  && state.invalidConstraints.length === 0
  && String(state.eventTypeDefault).includes('notice');

async function findCheckViolations(executor: Pick<DataSource, 'query'> = dataSource) {
  const violations: Array<{ constraint: string; count: number; values: unknown[] }> = [];
  for (const spec of SCHEMA_SHAPE_CHECKS) {
    const [row] = await executor.query(
      `SELECT COUNT(*)::integer AS count,
              COALESCE(json_agg(DISTINCT ${spec.column}) FILTER (WHERE ${spec.column} IS NOT NULL), '[]'::json) AS values
         FROM ${spec.table}
        WHERE NOT (${spec.expression})`,
    ) as Array<{ count: number; values: unknown[] }>;
    if (Number(row?.count ?? 0) > 0) {
      violations.push({ constraint: spec.name, count: Number(row.count), values: row.values });
    }
  }
  return violations;
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const before = await readback();
  const violations = await findCheckViolations();
  if (violations.length > 0) {
    console.log(JSON.stringify({
      ok: false,
      migration: SCHEMA_SHAPE_INTEGRITY_MIGRATION_ID,
      preflightViolations: violations,
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    await dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [78, 4]);
      for (const sql of SCHEMA_SHAPE_INTEGRITY_SQL) await manager.query(sql);
      const preview = await readback(manager);
      if (!complete(preview)) throw new Error('schema shape dry-run readback failed');
      throw new Error('__ROLLBACK_PREVIEW__');
    }).catch((error) => {
      if (!(error instanceof Error) || error.message !== '__ROLLBACK_PREVIEW__') throw error;
    });
    const afterRollback = await readback();
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: SCHEMA_SHAPE_INTEGRITY_MIGRATION_ID,
      before,
      rollbackPreserved: JSON.stringify(before) === JSON.stringify(afterRollback),
    }, null, 2));
    return;
  }

  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [78, 4]);
    const current = await readback(manager);
    if (!complete(current)) {
      for (const sql of SCHEMA_SHAPE_INTEGRITY_SQL) await manager.query(sql);
    }
    const verified = await readback(manager);
    if (!complete(verified)) throw new Error('schema shape migration readback failed');
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
      [SCHEMA_SHAPE_INTEGRITY_MIGRATION_ID],
    );
  });

  const after = await readback();
  if (!complete(after) || !after.ledgerApplied) throw new Error('schema shape migration ledger/readback failed');
  console.log(JSON.stringify({ ok: true, migration: SCHEMA_SHAPE_INTEGRITY_MIGRATION_ID, after }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
