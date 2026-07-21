import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import {
  COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID,
  COUNSEL_STUDENT_SSOT_CONTRACT_SQL,
} from '../src/database/migrations/counsel-student-ssot-contract.migration';

loadLocalEnv();
const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const legacyCounselColumns = [
  'applicant_name', 'applicant_phone', 'parent_id', 'interest_subject_id', 'interest_course_id',
  'academy_expectation', 'desired_start_time', 'learning_atmosphere', 'student_intention', 'weakness',
] as const;

async function state(): Promise<Record<string, unknown>> {
  const columns = await dataSource.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public'
        AND ((table_name='counsel_forms' AND column_name = ANY($1))
          OR (table_name='students' AND column_name = ANY($2)))
      ORDER BY table_name, column_name`,
    [legacyCounselColumns, ['grade', 'school_name']],
  ) as Array<{ table_name: string; column_name: string }>;
  const counselLegacyPresent = columns.some((row) => row.table_name === 'counsel_forms');
  const studentLegacyPresent = columns.some((row) => row.table_name === 'students');
  const [base] = await dataSource.query(`SELECT
    (SELECT COUNT(*)::int FROM counsel_forms WHERE deleted_at IS NULL AND student_id IS NULL) AS active_counsel_without_student,
    (SELECT COUNT(*)::int FROM students s WHERE s.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM student_academic_histories h
       WHERE h.student_id=s.id AND h.deleted_at IS NULL
         AND h.started_on <= CURRENT_DATE AND (h.ended_on IS NULL OR h.ended_on >= CURRENT_DATE)
    )) AS active_students_without_current_academic`);
  let activeLegacyCounselValues = 0;
  let academicProjectionMismatches = 0;
  if (counselLegacyPresent) {
    const [row] = await dataSource.query(`SELECT COUNT(*)::int AS count FROM counsel_forms
      WHERE deleted_at IS NULL AND (
        interest_subject_id IS NOT NULL OR interest_course_id IS NOT NULL OR academy_expectation IS NOT NULL
        OR desired_start_time IS NOT NULL OR learning_atmosphere IS NOT NULL OR student_intention IS NOT NULL OR weakness IS NOT NULL
      )`);
    activeLegacyCounselValues = Number(row.count);
  }
  if (studentLegacyPresent) {
    const [row] = await dataSource.query(`SELECT COUNT(*)::int AS count
      FROM students s
      JOIN LATERAL (
        SELECT h.grade, h.school_name FROM student_academic_histories h
         WHERE h.student_id=s.id AND h.deleted_at IS NULL
           AND h.started_on <= CURRENT_DATE AND (h.ended_on IS NULL OR h.ended_on >= CURRENT_DATE)
         ORDER BY h.started_on DESC, h.id DESC LIMIT 1
      ) current ON true
      WHERE s.deleted_at IS NULL AND (s.grade IS DISTINCT FROM current.grade OR s.school_name IS DISTINCT FROM current.school_name)`);
    academicProjectionMismatches = Number(row.count);
  }
  return {
    remainingColumns: columns.map((row) => `${row.table_name}.${row.column_name}`),
    activeCounselWithoutStudent: Number(base.active_counsel_without_student),
    activeLegacyCounselValues,
    activeStudentsWithoutCurrentAcademic: Number(base.active_students_without_current_academic),
    academicProjectionMismatches,
  };
}

async function main(): Promise<void> {
  await dataSource.initialize();
  const current = await state();
  const blockers = [
    Number(current.activeCounselWithoutStudent) && 'student_id 없는 활성 상담',
    Number(current.activeLegacyCounselValues) && 'reference_notes로 분류되지 않은 활성 legacy 상담값',
    Number(current.activeStudentsWithoutCurrentAcademic) && '현재 academic history 없는 활성 학생',
    Number(current.academicProjectionMismatches) && '학생 projection과 academic history 불일치',
  ].filter(Boolean);
  if (!apply) {
    console.log(JSON.stringify({ ok: blockers.length === 0, dryRun: true, migration: COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID, blockers, current }, null, 2));
    if (blockers.length) process.exitCode = 1;
    return;
  }
  if (blockers.length) throw new Error(`contract migration 중단: ${blockers.join(', ')}`);
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [38, 2]);
    await manager.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(100) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID]);
    if (applied.length) return;
    for (const sql of COUNSEL_STUDENT_SSOT_CONTRACT_SQL) await manager.query(sql);
    await manager.query('INSERT INTO schema_migrations (id) VALUES ($1)', [COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID]);
  });
  console.log(JSON.stringify({ ok: true, migration: COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID, after: await state() }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });

