import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID,
  COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL,
} from '../src/database/migrations/counsel-family-academic-expand.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function state(): Promise<Record<string, unknown>> {
  const [row] = await dataSource.query(`SELECT
    to_regclass('public.student_family_relations') IS NOT NULL AS family_table,
    to_regclass('public.student_academic_histories') IS NOT NULL AS academic_table,
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='counsel_forms' AND column_name='reference_notes') AS reference_notes,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='students_grade_check') AS grade_constraint,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE conrelid='student_family_relations'::regclass AND contype='f') AS family_fk_count,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE conrelid='student_family_relations'::regclass AND contype='c') AS family_check_count,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE conrelid='student_academic_histories'::regclass AND contype='f') AS academic_fk_count,
    (SELECT COUNT(*)::int FROM pg_constraint WHERE conrelid='student_academic_histories'::regclass AND contype='c') AS academic_check_count,
    to_regclass('public.uq_student_family_relations_active_pair') IS NOT NULL AS family_pair_index,
    to_regclass('public.idx_student_family_relations_b') IS NOT NULL AS family_reverse_index,
    to_regclass('public.idx_student_academic_histories_student_start') IS NOT NULL AS academic_start_index,
    to_regclass('public.idx_student_academic_histories_student_end') IS NOT NULL AS academic_end_index,
    (SELECT COUNT(*)::int FROM students WHERE grade NOT BETWEEN 0 AND 13) AS invalid_student_grades`);
  return row;
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const current = await state();
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, migration: COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID, current }, null, 2));
    return;
  }
  if (Number(current.invalid_student_grades) > 0) throw new Error(`grade 0..13 밖 학생 ${current.invalid_student_grades}행 때문에 migration을 중단합니다.`);
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [38, 1]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID]);
  });
  console.log(JSON.stringify({ ok: true, migration: COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID, after: await state() }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
