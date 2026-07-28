// [74D-1 2026-07-28] 출결·리포트 **읽기 전용** 인벤토리 — §51.3 첫 단계(정확한 id·count 저장).
//  대상: orphan(각 FK별)·invalid status·중복 활성 쌍(부분 유니크 검증)·soft-deleted 부모를
//  가리키는 활성 자식(정보 — FK 위반 아님·앱 규약 판정). 쓰기 0(SELECT만). PII 출력 0(id·count만).
import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const CAP = 20; // id 표본 상한(전체 수는 count로)

type Finding = { count: number; sampleIds: number[] };
const finding = async (countSql: string, idsSql: string): Promise<Finding> => {
  const [c] = await dataSource.query(countSql);
  const ids = c.n > 0 ? (await dataSource.query(idsSql)).map((r: { id: number }) => r.id) : [];
  return { count: Number(c.n), sampleIds: ids };
};

async function main(): Promise<void> {
  await dataSource.initialize();
  const has = async (t: string) => (await dataSource.query(`SELECT to_regclass('public.${t}') IS NOT NULL AS p`))[0].p === true;
  if (!(await has('attendance')) || !(await has('session_reports'))) {
    console.log(JSON.stringify({ ok: false, note: 'attendance/session_reports 표 부재 — 부팅/마이그레이션 후 재실행' }));
    return;
  }
  const out: Record<string, unknown> = { migrationTarget: '20260728_01_74d1_attendance_reports_constraints' };

  // 1) orphan — FK 후보별(물리 부재 참조만; soft delete는 물리 보존이라 여기 안 잡힘)
  out.attendanceSessionOrphans = await finding(
    `SELECT COUNT(*)::int AS n FROM attendance a LEFT JOIN class_sessions s ON s.id=a.session_id WHERE s.id IS NULL`,
    `SELECT a.id FROM attendance a LEFT JOIN class_sessions s ON s.id=a.session_id WHERE s.id IS NULL ORDER BY a.id LIMIT ${CAP}`);
  out.attendanceStudentOrphans = await finding(
    `SELECT COUNT(*)::int AS n FROM attendance a LEFT JOIN students st ON st.id=a.student_id WHERE st.id IS NULL`,
    `SELECT a.id FROM attendance a LEFT JOIN students st ON st.id=a.student_id WHERE st.id IS NULL ORDER BY a.id LIMIT ${CAP}`);
  out.reportSessionOrphans = await finding(
    `SELECT COUNT(*)::int AS n FROM session_reports r LEFT JOIN class_sessions s ON s.id=r.session_id WHERE s.id IS NULL`,
    `SELECT r.id FROM session_reports r LEFT JOIN class_sessions s ON s.id=r.session_id WHERE s.id IS NULL ORDER BY r.id LIMIT ${CAP}`);
  out.reportStudentOrphans = await finding(
    `SELECT COUNT(*)::int AS n FROM session_reports r LEFT JOIN students st ON st.id=r.student_id WHERE st.id IS NULL`,
    `SELECT r.id FROM session_reports r LEFT JOIN students st ON st.id=r.student_id WHERE st.id IS NULL ORDER BY r.id LIMIT ${CAP}`);
  out.reportInstructorOrphans = await finding(
    `SELECT COUNT(*)::int AS n FROM session_reports r LEFT JOIN users u ON u.id=r.instructor_id WHERE u.id IS NULL`,
    `SELECT r.id FROM session_reports r LEFT JOIN users u ON u.id=r.instructor_id WHERE u.id IS NULL ORDER BY r.id LIMIT ${CAP}`);
  out.reportApprovedByOrphans = await finding(
    `SELECT COUNT(*)::int AS n FROM session_reports r LEFT JOIN users u ON u.id=r.approved_by WHERE r.approved_by IS NOT NULL AND u.id IS NULL`,
    `SELECT r.id FROM session_reports r LEFT JOIN users u ON u.id=r.approved_by WHERE r.approved_by IS NOT NULL AND u.id IS NULL ORDER BY r.id LIMIT ${CAP}`);
  out.reportSubjectOrphans = await finding(
    `SELECT COUNT(*)::int AS n FROM session_reports r LEFT JOIN subjects sb ON sb.id=r.subject_id WHERE r.subject_id IS NOT NULL AND sb.id IS NULL`,
    `SELECT r.id FROM session_reports r LEFT JOIN subjects sb ON sb.id=r.subject_id WHERE r.subject_id IS NOT NULL AND sb.id IS NULL ORDER BY r.id LIMIT ${CAP}`);

  // 2) invalid status — CHECK 예정 집합 밖 값(값 자체도 출력 — PII 아님)
  out.attendanceInvalidStatus = await dataSource.query(
    `SELECT status, COUNT(*)::int AS n FROM attendance WHERE status NOT IN ('present','late','absent','excused') GROUP BY status`);
  out.reportInvalidStatus = await dataSource.query(
    `SELECT status, COUNT(*)::int AS n FROM session_reports WHERE status NOT IN ('draft','submitted','sent') GROUP BY status`);
  out.reportInvalidApprovalStatus = await dataSource.query(
    `SELECT approval_status, COUNT(*)::int AS n FROM session_reports WHERE approval_status NOT IN ('draft','submitted','approved','rejected') GROUP BY approval_status`);

  // 3) 중복 활성 쌍 — 부분 유니크(uq_*_session_student WHERE deleted_at IS NULL) 실측 재검증
  out.attendanceActiveDuplicates = await dataSource.query(
    `SELECT session_id, student_id, COUNT(*)::int AS n FROM attendance WHERE deleted_at IS NULL GROUP BY 1,2 HAVING COUNT(*)>1 LIMIT ${CAP}`);
  out.reportActiveDuplicates = await dataSource.query(
    `SELECT session_id, student_id, COUNT(*)::int AS n FROM session_reports WHERE deleted_at IS NULL GROUP BY 1,2 HAVING COUNT(*)>1 LIMIT ${CAP}`);

  // 4) 활성 자식 → soft-deleted 부모(정보 — FK 위반 아님, 앱 soft-delete 동반 전이 규약 감사용)
  const [a4] = await dataSource.query(
    `SELECT COUNT(*)::int AS n FROM attendance a JOIN class_sessions s ON s.id=a.session_id
     WHERE a.deleted_at IS NULL AND s.deleted_at IS NOT NULL`);
  const [r4] = await dataSource.query(
    `SELECT COUNT(*)::int AS n FROM session_reports r JOIN class_sessions s ON s.id=r.session_id
     WHERE r.deleted_at IS NULL AND s.deleted_at IS NOT NULL`);
  out.activeChildOfSoftDeletedSession = { attendance: Number(a4.n), sessionReports: Number(r4.n) };

  const blockers = ['attendanceSessionOrphans','attendanceStudentOrphans','reportSessionOrphans','reportStudentOrphans','reportInstructorOrphans','reportApprovedByOrphans','reportSubjectOrphans']
    .map((k) => (out[k] as Finding).count).reduce((a, b) => a + b, 0)
    + (out.attendanceInvalidStatus as unknown[]).length + (out.reportInvalidStatus as unknown[]).length
    + (out.reportInvalidApprovalStatus as unknown[]).length
    + (out.attendanceActiveDuplicates as unknown[]).length + (out.reportActiveDuplicates as unknown[]).length;
  out.ok = blockers === 0;
  out.verdict = blockers === 0
    ? '적용 가능 — orphan/invalid/duplicate 0 (soft-deleted 부모 참조는 정보 항목)'
    : `적용 금지 — 차단 항목 ${blockers}건: 교정 계획 승인 후 재실행`;
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (dataSource.isInitialized) await dataSource.destroy();
});
