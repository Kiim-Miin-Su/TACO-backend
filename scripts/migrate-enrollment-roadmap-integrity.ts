import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_ID,
  ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_SQL,
} from '../src/database/migrations/enrollment-roadmap-integrity.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function state(): Promise<Record<string, boolean | number>> {
  const [row] = await dataSource.query(`SELECT
    EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname='fk_enrollments_roadmap' AND convalidated
    ) AS fk_validated,
    EXISTS (
      SELECT 1 FROM pg_indexes
       WHERE schemaname='public' AND indexname='idx_enrollments_roadmap_active'
    ) AS index_exists,
    (SELECT COUNT(*)::int
       FROM enrollments e
       LEFT JOIN roadmaps r ON r.id=e.roadmap_id
      WHERE e.roadmap_id IS NOT NULL AND r.id IS NULL) AS orphan_count,
    (SELECT COUNT(*)::int
       FROM enrollments e
       LEFT JOIN roadmaps r ON r.id=e.roadmap_id
       LEFT JOIN roadmap_courses rc
         ON rc.roadmap_id=e.roadmap_id AND rc.course_id=e.course_id AND rc.deleted_at IS NULL
      WHERE e.deleted_at IS NULL AND e.roadmap_id IS NOT NULL
        AND (
          r.deleted_at IS NOT NULL
          OR (e.status='active' AND r.is_active IS NOT TRUE)
          OR rc.id IS NULL
        )) AS semantic_issue_count,
    EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='schema_migrations'
    ) AS ledger_exists`);
  let ledgerApplied = false;
  if (row.ledger_exists) {
    const [ledger] = await dataSource.query(
      'SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied',
      [ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_ID],
    );
    ledgerApplied = ledger.applied === true;
  }
  return {
    fkValidated: row.fk_validated === true,
    indexExists: row.index_exists === true,
    orphanCount: Number(row.orphan_count),
    semanticIssueCount: Number(row.semantic_issue_count),
    ledgerApplied,
  };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      migration: ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_ID,
      current: await state(),
    }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [77, 7]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query(
      'SELECT id FROM schema_migrations WHERE id=$1',
      [ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_ID],
    );
    if (applied.length) return;
    for (const sql of ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_SQL) await manager.query(sql);
    await manager.query(
      'INSERT INTO schema_migrations (id) VALUES ($1)',
      [ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_ID],
    );
  });
  const after = await state();
  if (
    !after.fkValidated
    || !after.indexExists
    || after.orphanCount !== 0
    || after.semanticIssueCount !== 0
    || !after.ledgerApplied
  ) {
    throw new Error('enrollment roadmap integrity migration readback failed');
  }
  console.log(JSON.stringify({
    ok: true,
    migration: ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_ID,
    after,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
