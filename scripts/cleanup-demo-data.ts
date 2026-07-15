import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

// [시범운영 2026-07-15] 데모/목 데이터 전면 정리 — 실계정만 남기고 도메인 데이터를 비운다.
//  · 보존: schema_migrations(장부), users의 super_admin(대표 실계정 — 아이디를 바꿨어도 role로 식별).
//  · 삭제: 도메인 표 전체(수업/시리즈/가용/학생/보호자/수강/결제/지출/원장/정산/출결/보고서/계약/
//    이벤트/과목/코스/강의실/요청/프리셋/인증 challenge) + super_admin 외 데모 계정과 그 강사 프로필.
//  · KEEP_LOGS=1이면 audit_log/auth_events(이력)를 보존한다(기본은 함께 정리 — 새 출발).
//  · dry-run 기본(행 수만 출력), APPLY=1일 때만 삭제. 전체가 한 트랜잭션(중간 실패 시 전무).
loadLocalEnv();
const apply = process.env.APPLY === '1';
const keepLogs = process.env.KEEP_LOGS === '1';
const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const dataSource = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' },
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

// FK-안전 삭제 순서(자식 → 부모). 존재하지 않는 표는 건너뛴다(배포 시점 차이 방어).
const DOMAIN_TABLES = [
  'attendance', 'session_reports', 'instructor_payouts', 'transactions', 'payments', 'expenses',
  'schedule_requests', 'calendar_view_presets', 'class_sessions', 'class_session_series',
  'availability_blocks', 'enrollments', 'parent_student_relations', 'parents', 'students',
  'instructor_contracts', 'courses', 'subjects', 'rooms', 'academy_events',
  'profile_verification_challenges', 'profile_change_requests',
];
const LOG_TABLES = ['audit_log', 'auth_events'];

async function main(): Promise<void> {
  await dataSource.initialize();
  const exists = async (t: string): Promise<boolean> =>
    (await dataSource.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`]))[0]?.ok === true;
  const count = async (t: string): Promise<number> =>
    Number((await dataSource.query(`SELECT COUNT(*) AS n FROM ${t}`))[0]?.n ?? 0);

  const targets = [...DOMAIN_TABLES, ...(keepLogs ? [] : LOG_TABLES)];
  const present: string[] = [];
  const before: Record<string, number> = {};
  for (const t of targets) if (await exists(t)) { present.push(t); before[t] = await count(t); }

  const demoUsers = await dataSource.query(
    `SELECT id, web_id, role FROM users WHERE role <> 'super_admin' ORDER BY id`,
  );
  const keepUsers = await dataSource.query(
    `SELECT id, web_id, role FROM users WHERE role = 'super_admin' ORDER BY id`,
  );

  if (!apply) {
    console.log(JSON.stringify({
      ok: true, dryRun: true, keepLogs,
      willDeleteRowsPerTable: before,
      willDeleteUsers: demoUsers.map((u: { web_id: string; role: string }) => `${u.web_id}(${u.role})`),
      willKeepUsers: keepUsers.map((u: { web_id: string; role: string }) => `${u.web_id}(${u.role})`),
    }, null, 2));
    return;
  }

  // [함정] pool max=1 — tx 내부에서 dataSource.query(pool)를 부르면 자기 자신을 기다리다
  //  connect timeout이 난다. 존재 확인은 tx 진입 전에 끝내고, tx 안은 manager.query만 쓴다.
  const hasProfiles = await exists('instructor_profiles');
  await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [29, 9]);
    for (const t of present) await manager.query(`DELETE FROM ${t}`);
    // 데모 계정: instructor_profiles(FK) 먼저, users는 super_admin만 보존.
    if (hasProfiles) {
      await manager.query(`DELETE FROM instructor_profiles WHERE user_id IN (SELECT id FROM users WHERE role <> 'super_admin')`);
    }
    await manager.query(`DELETE FROM users WHERE role <> 'super_admin'`);
  });

  const after: Record<string, number> = {};
  for (const t of present) after[t] = await count(t);
  const users = await dataSource.query(`SELECT web_id, role FROM users ORDER BY id`);
  console.log(JSON.stringify({
    ok: true, applied: true, keepLogs,
    rowsAfter: after,
    usersRemaining: users.map((u: { web_id: string; role: string }) => `${u.web_id}(${u.role})`),
  }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
