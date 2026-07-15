import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { PARENTS_MIGRATION_ID, PARENTS_MIGRATION_SQL } from '../src/database/migrations/parents.migration';

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
  SELECT to_regclass('public.parents') IS NOT NULL AS parents,
         to_regclass('public.parent_student_relations') IS NOT NULL AS relations,
         EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_parent_relations_student') AS student_fk,
         EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_parent_student_primary') AS primary_unique`;

async function main(): Promise<void> {
  await dataSource.initialize();
  const [reg] = await dataSource.query(`SELECT to_regclass('public.students') IS NOT NULL AS students_exists`);
  if (!reg?.students_exists) throw new Error('students 테이블이 없습니다 — 대상 DB를 확인하세요(FK 선행 조건).');
  const [current] = await dataSource.query(STATE_SQL);
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: PARENTS_MIGRATION_ID, current }, null, 2));
    return;
  }
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 7]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [PARENTS_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of PARENTS_MIGRATION_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [PARENTS_MIGRATION_ID]);
  });
  const [state] = await dataSource.query(STATE_SQL);
  const [after] = await dataSource.query(
    `SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE id=$1) AS applied`, [PARENTS_MIGRATION_ID],
  );
  console.log(JSON.stringify({ ok: true, migration: PARENTS_MIGRATION_ID, after: { ...after, ...state } }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
