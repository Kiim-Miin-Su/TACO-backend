// [TBO-61 2026-07-24] mock(데모 시드) 데이터 점검·소프트 딜리트 CLI — 대표 직접 운용 도구.
//  대표 지시: "내가 직접 mock-data로 의심되는 것들 지우는 게 좋을 것 같음. 소프트 딜리트가
//  추천되는 항목은 스크립트로 — check / delete 매개변수".
//
//  사용법(backend에서, owner DB URL 필요 — DOTENV_CONFIG_PATH=.env.local 또는 env 직접):
//    npm run db:mock-data -- check                       # 전 표 의심 행 리포트(쓰기 0)
//    npm run db:mock-data -- check --table students      # 한 표만
//    npm run db:mock-data -- delete --table students --ids 1,2,3        # 명시 행 소프트 딜리트(계획만)
//    npm run db:mock-data -- delete --table students --ids 1,2,3 --yes  # 실제 적용
//    npm run db:mock-data -- delete --suspected --yes                    # 의심 행 전체 소프트 딜리트
//    npm run db:mock-data -- delete --suspected --table class_sessions --yes
//
//  판정 원천: test/fixtures/business-fixtures.json(데모 시드의 단일 진실원)의 자연키
//  (학생 이름+영문명·과목/수업/강의실/이벤트/지출/로드맵 제목·데모 강사 webId) + 참조 닫힘.
//  안전 규약: ① 삭제는 전부 soft delete(deleted_at) — 하드 DELETE 없음 ② users·countries·
//  audit·auth 계열은 대상 제외 ③ 실데이터 가드 — 비데모 학생을 참조하는 행은 의심에서 제외하고
//  경고로 보고 ④ --yes 없으면 계획만 출력 ⑤ 적용 전 Neon 스냅샷은 런북 §3 상시 규약.
import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fixtures = require('../test/fixtures/business-fixtures.json') as Record<string, Array<Record<string, unknown>>>;

const args = process.argv.slice(2);
const mode = args[0];
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith('--') ? 'true' : args[i + 1] ?? 'true') : undefined;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const url = directDatabaseUrl();
if (!url) {
  console.error('DATABASE_URL_UNPOOLED, DATABASE_URL, POSTGRES_URL_NON_POOLING, or POSTGRES_URL is required');
  process.exit(1);
}
loadLocalEnv();

const ds = new DataSource({
  type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
  ssl: resolvePgSsl(),
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => ds.query(sql, params);
const exists = async (t: string): Promise<boolean> =>
  ((await q<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`]))[0]?.ok) === true;
const idsOf = (rows: Array<{ id: number }>): number[] => rows.map((r) => Number(r.id));
const inList = (ids: number[]): string => (ids.length ? ids.join(',') : 'NULL');
// NOT IN (NULL)은 항상 NULL(no rows)이 되는 SQL 함정 — 빈 집합이면 항상 참으로 전개한다.
const notIn = (col: string, ids: number[]): string => (ids.length ? `${col} NOT IN (${ids.join(',')})` : 'TRUE');

// 삭제 허용 표(전부 deleted_at 보유) — users·countries·audit_log·auth_* 는 의도적으로 제외.
const DELETABLE = [
  'students', 'parents', 'parent_student_relations', 'student_academic_histories', 'student_family_relations',
  'student_interests', 'subjects', 'courses', 'rooms', 'availability_blocks', 'class_session_series',
  'class_sessions', 'schedule_requests', 'enrollments', 'attendance', 'session_reports', 'payments',
  'expenses', 'instructor_payouts', 'transactions', 'counsel_forms', 'counsel_rounds', 'roadmaps',
  'roadmap_courses', 'academy_events', 'instructor_contracts',
] as const;
type Table = (typeof DELETABLE)[number];

// check 출력용 라벨 — 행을 사람이 식별할 수 있는 최소 정보(연락처 등 민감 원문은 넣지 않는다).
const LABEL: Partial<Record<Table, string>> = {
  students: `name || COALESCE(' ('||english_name||')','')`,
  parents: `name`,
  subjects: `name`,
  courses: `name`,
  rooms: `name`,
  academy_events: `title`,
  expenses: `title || ' ₩' || amount`,
  roadmaps: `title`,
  class_sessions: `COALESCE(topic,'(무제)') || ' ' || session_date`,
  class_session_series: `repeat_kind || ' ' || starts_on || '~' || COALESCE(ends_on::text,'')`,
  schedule_requests: `COALESCE(topic,'(무제)') || ' ' || COALESCE(session_date::text,'')`,
  enrollments: `'student='||student_id||' course='||course_id`,
  attendance: `'session='||session_id||' student='||student_id`,
  session_reports: `'session='||session_id||' student='||student_id`,
  payments: `'student='||COALESCE(student_id::text,'?')||' ₩'||amount||COALESCE(' due '||due_at,'')`,
  instructor_payouts: `'instructor='||instructor_id||' '||period_start||'~'||period_end||' ₩'||amount`,
  transactions: `direction||' '||category||' ₩'||amount`,
  counsel_forms: `'student='||COALESCE(student_id::text,'?')||' ('||status||')'`,
  counsel_rounds: `'form='||counsel_form_id||' round '||round_no`,
  parent_student_relations: `'parent='||parent_id||' student='||student_id`,
  student_academic_histories: `'student='||student_id||' '||COALESCE(school_name,'')`,
  student_family_relations: `'a='||student_id_a||' b='||student_id_b`,
  student_interests: `'student='||student_id`,
  availability_blocks: `owner_type||'='||owner_id||' w'||weekday||' '||start_time`,
  instructor_contracts: `'instructor='||instructor_id||' ₩'||hourly_rate||'/h'`,
  roadmap_courses: `'roadmap='||roadmap_id||' course='||course_id`,
};

type Sets = Record<string, number[]>;
type Warning = { table: string; note: string; ids: number[] };

/** fixture 자연키 + 참조 닫힘으로 표별 의심 id 집합을 계산한다(전부 active 행 한정). */
async function computeSuspects(): Promise<{ sets: Sets; warnings: Warning[] }> {
  const sets: Sets = {};
  const warnings: Warning[] = [];
  const set = async (t: Table, sql: string, params: unknown[] = []) => {
    sets[t] = (await exists(t)) ? idsOf(await q(sql, params)) : [];
  };

  // 데모 강사(수업·정산·가용시간 스코프) — admin/manager는 실운영 계정 겸용이라 절대 스코프에 넣지 않는다.
  const demoInstructorWebIds = (fixtures.users ?? [])
    .filter((u) => u.role === 'instructor').map((u) => String(u.webId));
  const demoInstructorIds = (await exists('users'))
    ? idsOf(await q(`SELECT id FROM users WHERE web_id = ANY($1) AND deleted_at IS NULL`, [demoInstructorWebIds]))
    : [];

  const studentPairs = (fixtures.students ?? []).map((s) => [String(s.name), String(s.englishName ?? '')]);
  await set('students', `
    SELECT id FROM students WHERE deleted_at IS NULL
      AND (name, COALESCE(english_name, '')) IN (${studentPairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')})
  `, studentPairs.flat());

  const byNames = async (t: Table, col: string, names: unknown[]) =>
    set(t, `SELECT id FROM ${t} WHERE deleted_at IS NULL AND ${col} = ANY($1)`, [names.map(String)]);
  await byNames('subjects', 'name', (fixtures.subjects ?? []).map((r) => r.name));
  await byNames('courses', 'name', (fixtures.courses ?? []).map((r) => r.name));
  await byNames('rooms', 'name', (fixtures.rooms ?? []).map((r) => r.name));
  await byNames('academy_events', 'title', (fixtures.academy_events ?? []).map((r) => r.title));
  await byNames('expenses', 'title', (fixtures.expenses ?? []).map((r) => r.title));
  await byNames('roadmaps', 'title', (fixtures.roadmaps ?? []).map((r) => r.title));

  // 학부모: fixture 이름 일치 + 실학생과 연결된 학부모는 제외(가드).
  if (await exists('parents')) {
    const parentNames = (fixtures.parents ?? []).map((r) => String(r.name));
    const candidates = idsOf(await q(`SELECT id FROM parents WHERE deleted_at IS NULL AND name = ANY($1)`, [parentNames]));
    if (candidates.length && (await exists('parent_student_relations'))) {
      const linkedReal = idsOf(await q(`
        SELECT DISTINCT r.parent_id AS id FROM parent_student_relations r
        WHERE r.deleted_at IS NULL AND r.parent_id IN (${inList(candidates)})
          AND ${notIn('r.student_id', sets.students ?? [])}
          AND EXISTS (SELECT 1 FROM students s WHERE s.id = r.student_id AND s.deleted_at IS NULL)
      `));
      sets.parents = candidates.filter((id) => !linkedReal.includes(id));
      if (linkedReal.length) warnings.push({ table: 'parents', note: '실학생과 연결되어 제외(직접 확인 필요)', ids: linkedReal });
    } else {
      sets.parents = candidates;
    }
  } else sets.parents = [];

  // 세션: 데모 코스 또는 데모 강사 담당 — 단 비데모 활성 학생이 참여한 세션은 제외+경고.
  if (await exists('class_sessions')) {
    const cand = await q<{ id: number; student_ids: string }>(`
      SELECT id, student_ids FROM class_sessions WHERE deleted_at IS NULL
        AND (course_id IN (${inList(sets.courses ?? [])}) OR instructor_id IN (${inList(demoInstructorIds)}))
    `);
    const realStudents = new Set(
      idsOf(await q(`SELECT id FROM students WHERE deleted_at IS NULL AND ${notIn('id', sets.students ?? [])}`)),
    );
    const okIds: number[] = []; const guarded: number[] = [];
    for (const row of cand) {
      let participant: number[] = [];
      try { participant = (JSON.parse(row.student_ids || '[]') as number[]).map(Number); } catch { participant = []; }
      if (participant.some((sid) => realStudents.has(sid))) guarded.push(Number(row.id));
      else okIds.push(Number(row.id));
    }
    sets.class_sessions = okIds;
    if (guarded.length) warnings.push({ table: 'class_sessions', note: '비데모 학생 참여 세션이라 제외(직접 확인 필요)', ids: guarded });
  } else sets.class_sessions = [];

  // 시리즈: 의심 세션만 참조하는 시리즈(비데모 세션이 하나라도 살아있으면 제외).
  await set('class_session_series', `
    SELECT sr.id FROM class_session_series sr WHERE sr.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM class_sessions cs WHERE cs.series_id = sr.id AND cs.id IN (${inList(sets.class_sessions)}))
      AND NOT EXISTS (SELECT 1 FROM class_sessions cs2 WHERE cs2.series_id = sr.id AND cs2.deleted_at IS NULL
                        AND ${notIn('cs2.id', sets.class_sessions)})
  `);

  await set('schedule_requests', `
    SELECT id FROM schedule_requests WHERE deleted_at IS NULL
      AND (course_id IN (${inList(sets.courses ?? [])}) OR instructor_id IN (${inList(demoInstructorIds)})
           OR requester_id IN (${inList(demoInstructorIds)}))
  `);
  await set('enrollments', `
    SELECT id FROM enrollments WHERE deleted_at IS NULL AND student_id IN (${inList(sets.students ?? [])})
  `);
  // 실학생-데모수업 연결은 삭제하지 않고 보고만(수강 이력은 실데이터).
  if (await exists('enrollments')) {
    const crossed = idsOf(await q(`
      SELECT id FROM enrollments WHERE deleted_at IS NULL
        AND course_id IN (${inList(sets.courses ?? [])}) AND ${notIn('student_id', sets.students ?? [])}
    `));
    if (crossed.length) warnings.push({ table: 'enrollments', note: '실학생이 데모 수업에 수강 연결(직접 확인 필요)', ids: crossed });
  }
  await set('attendance', `
    SELECT id FROM attendance WHERE deleted_at IS NULL
      AND (student_id IN (${inList(sets.students ?? [])}) OR session_id IN (${inList(sets.class_sessions)}))
  `);
  await set('session_reports', `
    SELECT id FROM session_reports WHERE deleted_at IS NULL
      AND (student_id IN (${inList(sets.students ?? [])}) OR session_id IN (${inList(sets.class_sessions)}))
  `);
  await set('payments', `
    SELECT id FROM payments WHERE deleted_at IS NULL AND student_id IN (${inList(sets.students ?? [])})
  `);
  await set('instructor_payouts', `
    SELECT id FROM instructor_payouts WHERE deleted_at IS NULL AND instructor_id IN (${inList(demoInstructorIds)})
  `);
  {
    const txPairs = (fixtures.transactions ?? []).map((r) => [String(r.label ?? ''), Number(r.amount ?? 0)] as const);
    const pairSql = txPairs.length
      ? `OR (payment_id IS NULL AND payout_id IS NULL AND expense_id IS NULL AND (label, amount) IN (${txPairs.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')}))`
      : '';
    await set('transactions', `
      SELECT id FROM transactions WHERE deleted_at IS NULL AND (
        payment_id IN (${inList(sets.payments ?? [])}) OR payout_id IN (${inList(sets.instructor_payouts ?? [])})
        OR expense_id IN (${inList(sets.expenses ?? [])}) ${pairSql})
    `, txPairs.flat());
  }
  await set('counsel_forms', `
    SELECT id FROM counsel_forms WHERE deleted_at IS NULL AND student_id IN (${inList(sets.students ?? [])})
  `);
  await set('counsel_rounds', `
    SELECT id FROM counsel_rounds WHERE deleted_at IS NULL AND counsel_form_id IN (${inList(sets.counsel_forms ?? [])})
  `);
  await set('parent_student_relations', `
    SELECT id FROM parent_student_relations WHERE deleted_at IS NULL
      AND (student_id IN (${inList(sets.students ?? [])}) OR parent_id IN (${inList(sets.parents ?? [])}))
  `);
  await set('student_academic_histories', `
    SELECT id FROM student_academic_histories WHERE deleted_at IS NULL AND student_id IN (${inList(sets.students ?? [])})
  `);
  await set('student_family_relations', `
    SELECT id FROM student_family_relations WHERE deleted_at IS NULL
      AND (student_id_a IN (${inList(sets.students ?? [])}) OR student_id_b IN (${inList(sets.students ?? [])}))
  `);
  await set('student_interests', `
    SELECT id FROM student_interests WHERE deleted_at IS NULL AND student_id IN (${inList(sets.students ?? [])})
  `);
  await set('availability_blocks', `
    SELECT id FROM availability_blocks WHERE deleted_at IS NULL AND (
      (owner_type IN ('instructor','user') AND owner_id IN (${inList(demoInstructorIds)}))
      OR (owner_type = 'room' AND owner_id IN (${inList(sets.rooms ?? [])}))
      OR (owner_type = 'student' AND owner_id IN (${inList(sets.students ?? [])})))
  `);
  await set('instructor_contracts', `
    SELECT id FROM instructor_contracts WHERE deleted_at IS NULL AND instructor_id IN (${inList(demoInstructorIds)})
  `);
  await set('roadmap_courses', `
    SELECT id FROM roadmap_courses WHERE deleted_at IS NULL
      AND (roadmap_id IN (${inList(sets.roadmaps ?? [])}) OR course_id IN (${inList(sets.courses ?? [])}))
  `);
  return { sets, warnings };
}

async function report(only?: Table): Promise<void> {
  const limit = Number(flag('limit') ?? 40);
  const { sets, warnings } = await computeSuspects();
  console.log('── mock-data check (쓰기 0 · fixture 자연키+참조 닫힘 판정) ──');
  for (const t of DELETABLE) {
    if (only && t !== only) continue;
    if (!(await exists(t))) { console.log(`  ${t}: (표 없음)`); continue; }
    const [{ active }] = await q<{ active: number }>(`SELECT count(*)::int AS active FROM ${t} WHERE deleted_at IS NULL`);
    const suspected = sets[t] ?? [];
    console.log(`  ${t}: 활성 ${active} · 의심 ${suspected.length}${active - suspected.length > 0 ? ` · 보존 ${active - suspected.length}` : ''}`);
    if (suspected.length) {
      const label = LABEL[t] ?? `'id='||id`;
      const rows = await q<{ id: number; label: string; created_at: string }>(
        `SELECT id, ${label} AS label, created_at FROM ${t} WHERE id IN (${inList(suspected)}) ORDER BY id LIMIT ${limit}`,
      );
      for (const r of rows) console.log(`     · #${r.id} ${r.label} (created ${String(r.created_at).slice(0, 10)})`);
      if (suspected.length > limit) console.log(`     … 외 ${suspected.length - limit}건 (--limit 로 확장)`);
    }
  }
  // 보존 실데이터 요약(학생) — 삭제 대상이 아님을 명시적으로 보여준다.
  if ((!only || only === 'students') && (await exists('students'))) {
    const preserved = await q<{ id: number; label: string }>(`
      SELECT id, ${LABEL.students} AS label FROM students
      WHERE deleted_at IS NULL AND ${notIn('id', sets.students ?? [])} ORDER BY id LIMIT 30`);
    console.log(`  [보존] 비데모 활성 학생 ${preserved.length}명: ${preserved.map((r) => `#${r.id} ${r.label}`).join(' · ') || '(없음)'}`);
  }
  for (const w of warnings) console.log(`  ⚠ ${w.table}: ${w.note} — ids [${w.ids.join(', ')}]`);
  console.log('\n삭제(소프트): npm run db:mock-data -- delete --suspected --yes  (또는 --table <표> --ids <id,..> --yes)');
  console.log('⚠ 적용 전 Neon 브랜치 스냅샷(런북 §3) — 복구는 deleted_at = NULL 업데이트.');
}

async function runDelete(): Promise<void> {
  const only = flag('table') as Table | undefined;
  if (only && !DELETABLE.includes(only)) {
    console.error(`허용되지 않는 표: ${only}\n허용 목록: ${DELETABLE.join(', ')}`);
    process.exit(1);
  }
  const apply = has('yes');
  let plan: Array<{ table: Table; ids: number[] }> = [];

  if (has('suspected')) {
    const { sets, warnings } = await computeSuspects();
    plan = (only ? [only] : [...DELETABLE]).map((t) => ({ table: t, ids: sets[t] ?? [] })).filter((p) => p.ids.length);
    for (const w of warnings) console.log(`  ⚠ ${w.table}: ${w.note} — ids [${w.ids.join(', ')}] (삭제 계획에서 제외됨)`);
  } else {
    const ids = (flag('ids') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!only || !ids.length) {
      console.error('사용법: delete --table <표> --ids 1,2,3 [--yes]  또는  delete --suspected [--table <표>] [--yes]');
      process.exit(1);
    }
    plan = [{ table: only, ids }];
  }

  if (!plan.length) { console.log('삭제 대상 0 — 종료.'); return; }
  console.log(`── mock-data delete ${apply ? '(적용)' : '(계획만 — --yes 로 적용)'} ──`);
  for (const p of plan) {
    const label = LABEL[p.table] ?? `'id='||id`;
    const rows = await q<{ id: number; label: string }>(
      `SELECT id, ${label} AS label FROM ${p.table} WHERE id IN (${inList(p.ids)}) AND deleted_at IS NULL ORDER BY id LIMIT 40`);
    console.log(`  ${p.table}: ${p.ids.length}건 소프트 딜리트 ${apply ? '실행' : '예정'}`);
    for (const r of rows) console.log(`     · #${r.id} ${r.label}`);
  }
  if (!apply) { console.log('\n적용하려면 --yes 를 추가하세요(사전 Neon 스냅샷 필수 — 런북 §3).'); return; }

  await ds.transaction(async (m) => {
    for (const p of plan) {
      // typeorm의 UPDATE..RETURNING은 [rows, rowCount] 2요소 배열 — rows 길이로 집계.
      const result = (await m.query(
        `UPDATE ${p.table} SET deleted_at = now(), updated_at = now() WHERE id IN (${inList(p.ids)}) AND deleted_at IS NULL RETURNING id`,
      )) as unknown;
      const n = Array.isArray(result) && result.length === 2 && Array.isArray(result[0])
        ? (result[0] as unknown[]).length
        : Array.isArray(result) ? result.length : 0;
      console.log(`  ✓ ${p.table}: ${n}건 soft delete`);
    }
  });
  console.log('완료 — 복구가 필요하면 각 표에서 UPDATE ... SET deleted_at = NULL WHERE id IN (...).');
}

async function main(): Promise<void> {
  await ds.initialize();
  if (mode === 'check') await report(flag('table') as Table | undefined);
  else if (mode === 'delete') await runDelete();
  else {
    console.error('사용법: db:mock-data -- check [--table t] | delete (--suspected | --table t --ids 1,2) [--yes]');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  })
  .finally(async () => { if (ds.isInitialized) await ds.destroy(); });
