import 'reflect-metadata';
import { DataSource, type EntityManager } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();

type ResetMode = 'soft' | 'hard';
type KeepRule = { table: string; keepIds: number[]; note: string };
type WipeRule = { table: string; note: string };
type CountRow = { table_name: string; exists: boolean; active?: number; total?: number };
type ValidationIssue = { table: string; issue: string; count: number };
type QueryFn = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

const apply = process.env.APPLY === '1';
const resetMode: ResetMode = process.env.RESET_MODE === 'hard' ? 'hard' : 'soft';
const url = directDatabaseUrl();

if (!url) {
  console.error('DATABASE_URL_UNPOOLED, DATABASE_URL, POSTGRES_URL_NON_POOLING, or POSTGRES_URL is required for db:reset:demo');
  process.exit(1);
}

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  extra: {
    max: Number(process.env.DB_POOL_MAX ?? 1),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
  },
});

const keepRules: KeepRule[] = [
  { table: 'users', keepIds: [1, 2, 3, 4, 5], note: 'demo staff accounts only' },
  { table: 'students', keepIds: [1, 2, 3, 4], note: 'demo students only' },
  { table: 'subjects', keepIds: [1, 2], note: 'english/math demo subjects' },
  { table: 'courses', keepIds: [10, 11, 12], note: 'demo courses referenced by seed sessions' },
  { table: 'rooms', keepIds: [1, 2, 3], note: 'demo rooms referenced by seed sessions' },
  { table: 'enrollments', keepIds: [1, 2, 3, 4], note: 'demo course enrollments' },
  { table: 'availability_blocks', keepIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], note: 'default availability/unavailability/online-only blocks' },
  { table: 'class_sessions', keepIds: [1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 22, 23, 24, 25, 26, 27, 28], note: 'current-week and history demo sessions' },
  { table: 'attendance', keepIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], note: 'demo attendance rows' },
  { table: 'session_reports', keepIds: [1, 2, 3], note: 'demo submitted report rows' },
  { table: 'instructor_contracts', keepIds: [1, 2], note: 'demo instructor contracts' },
];

const wipeRules: WipeRule[] = [
  { table: 'schedule_requests', note: 'approval center should start empty for live QA' },
  { table: 'calendar_view_presets', note: 'saved views are user/runtime state, not base mock data' },
  { table: 'audit_log', note: 'runtime change history, not base mock data' },
];

const orderedTables = [
  ...wipeRules.map((r) => r.table),
  'attendance',
  'session_reports',
  'schedule_requests',
  'calendar_view_presets',
  'audit_log',
  'class_sessions',
  'availability_blocks',
  'instructor_contracts',
  'enrollments',
  'courses',
  'rooms',
  'subjects',
  'students',
  'users',
];

function idList(ids: number[]): string {
  if (!ids.length) return 'NULL';
  return ids.map((id) => Number(id)).join(', ');
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return dataSource.query(sql, params);
}

function managerQuery(manager: EntityManager): QueryFn {
  return <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => manager.query(sql, params);
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    )`,
    [table],
  );
  return !!rows[0]?.exists;
}

async function countTable(table: string): Promise<CountRow> {
  if (!(await tableExists(table))) return { table_name: table, exists: false };
  const [active] = await query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE deleted_at IS NULL`);
  const [total] = await query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return { table_name: table, exists: true, active: active?.count ?? 0, total: total?.count ?? 0 };
}

async function snapshot(): Promise<CountRow[]> {
  const uniqueTables = [...new Set(orderedTables)];
  const rows: CountRow[] = [];
  for (const table of uniqueTables) rows.push(await countTable(table));
  return rows;
}

async function previewTargets(): Promise<Record<string, unknown>> {
  const rows: Array<{ table: string; action: string; count: number; note: string }> = [];
  for (const rule of wipeRules) {
    if (!(await tableExists(rule.table))) continue;
    const where = resetMode === 'hard' ? 'TRUE' : 'deleted_at IS NULL';
    const [count] = await query<{ count: number }>(`SELECT count(*)::int AS count FROM ${rule.table} WHERE ${where}`);
    rows.push({ table: rule.table, action: resetMode === 'hard' ? 'delete_all' : 'soft_delete_all_active', count: count?.count ?? 0, note: rule.note });
  }
  for (const rule of keepRules) {
    if (!(await tableExists(rule.table))) continue;
    const where = resetMode === 'hard'
      ? `id NOT IN (${idList(rule.keepIds)})`
      : `deleted_at IS NULL AND id NOT IN (${idList(rule.keepIds)})`;
    const [count] = await query<{ count: number }>(`SELECT count(*)::int AS count FROM ${rule.table} WHERE ${where}`);
    rows.push({ table: rule.table, action: resetMode === 'hard' ? 'delete_non_seed' : 'soft_delete_active_non_seed', count: count?.count ?? 0, note: rule.note });
  }
  return { resetMode, rows };
}

async function softDeleteAll(run: QueryFn, table: string): Promise<void> {
  await run(`UPDATE ${table} SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL`);
}

async function softDeleteNonSeed(run: QueryFn, table: string, keepIds: number[]): Promise<void> {
  await run(`UPDATE ${table} SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL AND id NOT IN (${idList(keepIds)})`);
  await run(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE id IN (${idList(keepIds)})`);
}

async function hardDeleteAll(run: QueryFn, table: string): Promise<void> {
  await run(`DELETE FROM ${table}`);
}

async function hardDeleteNonSeed(run: QueryFn, table: string, keepIds: number[]): Promise<void> {
  await run(`DELETE FROM ${table} WHERE id NOT IN (${idList(keepIds)})`);
}

async function syncSequence(run: QueryFn, table: string): Promise<void> {
  await run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
}

async function validate(): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const count = async (table: string, issue: string, sql: string) => {
    if (!(await tableExists(table))) return;
    const [row] = await query<{ count: number }>(sql);
    const n = row?.count ?? 0;
    if (n > 0) issues.push({ table, issue, count: n });
  };

  await count('schedule_requests', 'approval center rows remain active', `SELECT count(*)::int AS count FROM schedule_requests WHERE deleted_at IS NULL`);
  await count('calendar_view_presets', 'runtime saved views remain active', `SELECT count(*)::int AS count FROM calendar_view_presets WHERE deleted_at IS NULL`);
  await count('audit_log', 'runtime audit rows remain active', `SELECT count(*)::int AS count FROM audit_log WHERE deleted_at IS NULL`);
  await count('class_sessions', 'non-seed sessions remain active', `SELECT count(*)::int AS count FROM class_sessions WHERE deleted_at IS NULL AND id NOT IN (${idList(keepRules.find((r) => r.table === 'class_sessions')!.keepIds)})`);
  await count('attendance', 'attendance points to missing active session/student', `
    SELECT count(*)::int AS count
    FROM attendance a
    LEFT JOIN class_sessions s ON s.id = a.session_id AND s.deleted_at IS NULL
    LEFT JOIN students st ON st.id = a.student_id AND st.deleted_at IS NULL
    WHERE a.deleted_at IS NULL AND (s.id IS NULL OR st.id IS NULL)
  `);
  await count('session_reports', 'reports point to missing active session/student/instructor', `
    SELECT count(*)::int AS count
    FROM session_reports r
    LEFT JOIN class_sessions s ON s.id = r.session_id AND s.deleted_at IS NULL
    LEFT JOIN students st ON st.id = r.student_id AND st.deleted_at IS NULL
    LEFT JOIN users u ON u.id = r.instructor_id AND u.deleted_at IS NULL AND u.role = 'instructor'
    WHERE r.deleted_at IS NULL AND (s.id IS NULL OR st.id IS NULL OR u.id IS NULL)
  `);
  await count('enrollments', 'enrollments point to missing active student/course', `
    SELECT count(*)::int AS count
    FROM enrollments e
    LEFT JOIN students st ON st.id = e.student_id AND st.deleted_at IS NULL
    LEFT JOIN courses c ON c.id = e.course_id AND c.deleted_at IS NULL
    WHERE e.deleted_at IS NULL AND (st.id IS NULL OR c.id IS NULL)
  `);
  await count('class_sessions', 'sessions point to missing active course/instructor/room', `
    SELECT count(*)::int AS count
    FROM class_sessions s
    LEFT JOIN courses c ON c.id = s.course_id AND c.deleted_at IS NULL
    LEFT JOIN users u ON u.id = s.instructor_id AND u.deleted_at IS NULL AND u.role = 'instructor'
    LEFT JOIN rooms r ON r.id = s.room_id AND r.deleted_at IS NULL
    WHERE s.deleted_at IS NULL AND (c.id IS NULL OR u.id IS NULL OR (s.room_id IS NOT NULL AND r.id IS NULL))
  `);
  return issues;
}

async function applyReset(): Promise<void> {
  const existingTables = new Set<string>();
  for (const table of [...new Set([...wipeRules.map((r) => r.table), ...keepRules.map((r) => r.table)])]) {
    if (await tableExists(table)) existingTables.add(table);
  }

  await dataSource.transaction(async (manager) => {
    const run = managerQuery(manager);
    for (const rule of wipeRules) {
      if (!existingTables.has(rule.table)) continue;
      if (resetMode === 'hard') await hardDeleteAll(run, rule.table);
      else await softDeleteAll(run, rule.table);
    }

    const byTable = new Map(keepRules.map((r) => [r.table, r]));
    for (const table of orderedTables) {
      const rule = byTable.get(table);
      if (!rule || !existingTables.has(table)) continue;
      if (resetMode === 'hard') await hardDeleteNonSeed(run, table, rule.keepIds);
      else await softDeleteNonSeed(run, table, rule.keepIds);
      await syncSequence(run, table);
    }
  });
}

async function main() {
  await dataSource.initialize();
  const before = await snapshot();
  const targets = await previewTargets();
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'dry-run',
      resetMode,
      applyHint: 'APPLY=1 npm run db:reset:demo',
      hardDeleteHint: 'RESET_MODE=hard APPLY=1 npm run db:reset:demo',
      before,
      targets,
    }, null, 2));
    return;
  }

  await applyReset();
  const after = await snapshot();
  const validationIssues = await validate();
  console.log(JSON.stringify({
    ok: validationIssues.length === 0,
    mode: 'applied',
    resetMode,
    before,
    targets,
    after,
    validationIssues,
  }, null, 2));
  if (validationIssues.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
