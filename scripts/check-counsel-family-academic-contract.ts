import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function main(): Promise<void> {
  await dataSource.initialize();
  const [counts] = await dataSource.query(`SELECT
    (SELECT COUNT(*)::int FROM students WHERE deleted_at IS NULL) AS active_students,
    (SELECT COUNT(*)::int FROM students s WHERE s.deleted_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM student_academic_histories h WHERE h.student_id=s.id AND h.deleted_at IS NULL
    )) AS students_without_timeline,
    (SELECT COUNT(*)::int FROM counsel_forms WHERE deleted_at IS NULL) AS active_counsel_forms,
    (SELECT COUNT(*)::int FROM counsel_forms WHERE deleted_at IS NULL AND student_id IS NOT NULL) AS linked_counsel_forms,
    (SELECT COUNT(*)::int FROM counsel_forms WHERE deleted_at IS NULL AND (
      learning_atmosphere IS NOT NULL OR interest_course_id IS NOT NULL OR student_intention IS NOT NULL OR academy_expectation IS NOT NULL
    )) AS active_legacy_counsel_values,
    (SELECT COUNT(*)::int FROM student_family_relations f LEFT JOIN students a ON a.id=f.student_id_a LEFT JOIN students b ON b.id=f.student_id_b
      WHERE f.deleted_at IS NULL AND (a.id IS NULL OR b.id IS NULL OR a.deleted_at IS NOT NULL OR b.deleted_at IS NOT NULL)) AS family_orphans,
    (SELECT COUNT(*)::int FROM student_academic_histories h LEFT JOIN students s ON s.id=h.student_id LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.deleted_at IS NULL AND (s.id IS NULL OR s.deleted_at IS NOT NULL OR u.id IS NULL OR u.deleted_at IS NOT NULL)) AS academic_orphans,
    (SELECT COUNT(*)::int FROM student_academic_histories WHERE deleted_at IS NULL AND ended_on IS NOT NULL AND started_on > ended_on) AS invalid_periods,
    (SELECT COUNT(*)::int FROM student_academic_histories a JOIN student_academic_histories b
      ON a.student_id=b.student_id AND a.id<b.id AND a.deleted_at IS NULL AND b.deleted_at IS NULL
      AND a.started_on <= COALESCE(b.ended_on, 'infinity'::date)
      AND COALESCE(a.ended_on, 'infinity'::date) >= b.started_on) AS overlapping_pairs`);
  const blockingKeys = ['students_without_timeline', 'family_orphans', 'academic_orphans', 'invalid_periods', 'overlapping_pairs'];
  const blockers = blockingKeys.filter((key) => Number(counts[key]) > 0);
  console.log(JSON.stringify({
    ok: blockers.length === 0,
    dryRun: true,
    checkedAt: new Date().toISOString(),
    counts,
    blockers,
    contractDecision: blockers.length
      ? 'backfill/repair 후 contract migration 가능'
      : '데이터 blocker는 0이지만 신규 backend/frontend production readback 전 destructive drop은 보류',
  }, null, 2));
  if (blockers.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
