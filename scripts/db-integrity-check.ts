// [B9 E5 2026-07-16] DB 무결성 전수 검증 — 읽기 전용(데이터 쓰기 0; 부팅 멱등 DDL만, 기존 스키마 no-op).
//  이 코드베이스는 재무 역참조·polymorphic 참조를 의도적으로 DB FK 미강제(앱단 검증 — erd.dbml 명문)
//  하므로, 그 앱단 규칙을 실 DB에서 실측하는 게 이 스크립트의 존재 이유다.
//  검사군: ① 회계 정합(checkAccountingIntegrity 재사용 — reversal 규칙 포함) ② 앱단 FK 고아
//  ③ soft delete 정합(삭제된 부모를 활성 자식이 참조) ④ partial unique 실측(활성 중복)
//  ⑤ 시퀀스 드리프트(information_schema 자동 탐색) ⑥ 재무 역참조 배타 ⑦ 감사 신호(경고 — 실패 아님)
//  ⑧ emailVerified 불변식(계정 레코드 존재=true — 대표 피드백 2026-07-20·TBO-31 C5 D10).
//  사용: DATABASE_URL=... npx ts-node? → 아니오: nest build 후 `npm run db:integrity`.
//  출력: JSON { ok, checkedAt, counts, issues[], warnings[] } · issues>0 → exitCode 1.
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { checkAccountingIntegrity, type AccountingIntegritySnapshot } from '../src/modules/payouts/accounting-integrity';
import { checkPayoutIntegrity } from '../src/modules/payouts/payout-integrity';
import type { BaseRow } from '../src/common/types/base';
import { loadLocalEnv } from '../src/config/load-env';

type Issue = { code: string; entity: string; entityId?: number; message: string };

// 앱단 FK 지도(자식.필드 → 부모) — DB FK가 없는 참조의 실측 대상. nullable 필드는 null이면 통과.
const APP_FK: Array<{ child: string; field: string; parent: string }> = [
  { child: 'transactions', field: 'paymentId', parent: 'payments' },
  { child: 'transactions', field: 'payoutId', parent: 'instructor_payouts' },
  { child: 'transactions', field: 'expenseId', parent: 'expenses' },
  { child: 'class_sessions', field: 'courseId', parent: 'courses' },
  { child: 'class_sessions', field: 'roomId', parent: 'rooms' },
  { child: 'enrollments', field: 'studentId', parent: 'students' },
  { child: 'enrollments', field: 'courseId', parent: 'courses' },
  { child: 'payments', field: 'studentId', parent: 'students' },
  { child: 'payments', field: 'enrollmentId', parent: 'enrollments' },
  { child: 'parent_student_relations', field: 'parentId', parent: 'parents' },
  { child: 'parent_student_relations', field: 'studentId', parent: 'students' },
  { child: 'student_interests', field: 'studentId', parent: 'students' },
  { child: 'student_interests', field: 'courseId', parent: 'courses' },
  { child: 'counsel_rounds', field: 'counselFormId', parent: 'counsel_forms' },
  { child: 'session_reports', field: 'subjectId', parent: 'subjects' },
  { child: 'courses', field: 'subjectId', parent: 'subjects' },
  { child: 'instructor_payouts', field: 'instructorId', parent: 'users' },
  { child: 'roadmap_courses', field: 'roadmapId', parent: 'roadmaps' },
  { child: 'roadmap_courses', field: 'courseId', parent: 'courses' },
];

// 활성 중복 검사(partial unique 실측) — DB 인덱스가 있는 것도 실측(인덱스 누락 배포 감시 겸용).
const ACTIVE_UNIQUE: Array<{ table: string; keys: string[]; ci?: boolean }> = [
  { table: 'enrollments', keys: ['studentId', 'courseId'] },
  { table: 'attendance', keys: ['sessionId', 'studentId'] },
  { table: 'session_reports', keys: ['sessionId', 'studentId'] },
  { table: 'nav_seen_states', keys: ['userId', 'navKey'] },
  { table: 'calendar_view_presets', keys: ['name'] },
  { table: 'users', keys: ['webId'], ci: true },
  { table: 'users', keys: ['email'], ci: true },
  { table: 'roadmap_courses', keys: ['roadmapId', 'courseId'] },
  { table: 'report_templates', keys: ['name'] },
  { table: 'student_interests', keys: ['studentId', 'priority'] },
  { table: 'student_interests', keys: ['studentId', 'courseId'] },
  { table: 'student_interests', keys: ['studentId', 'customLabel'], ci: true },
];

// 감사 원칙 대상에서 제외되는 테이블(erd.dbml audit_log Note 단일 소스와 동일).
const AUDIT_EXCLUDED = new Set([
  'audit_log', 'auth_events', 'auth_refresh_tokens', 'auth_rate_limits', 'profile_verification_challenges',
  'countries', 'instructor_contracts', 'nav_seen_states', 'signup_email_challenges', 'signup_phone_challenges',
]);

async function main() {
  loadLocalEnv();
  // Integrity readback must never inject E2E business fixtures into the target DB.
  process.env.TEST_BUSINESS_FIXTURES = '0';
  const app: INestApplication = await createTestApp();
  const db = app.get(InMemoryDatabase);
  const pg = app.get(PostgresConnectionService);
  if (!pg.ready) throw new Error('PostgreSQL 연결 필요(DATABASE_URL) — 무결성 검증은 영속 권위 소스 대상');
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  const rows = <T extends BaseRow>(t: string, withDeleted = false) => db.findAll<T>(t, { withDeleted });
  const push = (arr: Issue[], code: string, entity: string, entityId: number | undefined, message: string) =>
    arr.push({ code, entity, entityId, message });

  // ① 회계 정합(+B9 reversal 규칙) — 기존 순수 함수 재사용
  const snapshot: AccountingIntegritySnapshot = {
    sessions: rows('class_sessions') as never,
    attendance: rows('attendance') as never,
    reports: rows('session_reports') as never,
    payouts: rows('instructor_payouts') as never,
    transactions: rows('transactions') as never,
    students: rows('students') as never,
    enrollments: rows('enrollments') as never,
  };
  for (const found of checkAccountingIntegrity(snapshot)) issues.push(found);

  // ②③ 앱단 FK 고아 + soft delete 정합(삭제 부모를 활성 자식이 참조)
  for (const { child, field, parent } of APP_FK) {
    const parents = new Map(rows(parent, true).map((r) => [r.id, r]));
    for (const row of rows<BaseRow & Record<string, unknown>>(child)) {
      const ref = row[field];
      if (ref == null) continue;
      const target = parents.get(Number(ref));
      if (!target) push(issues, 'APP_FK_ORPHAN', child, row.id, `${field}=${ref} → ${parent} 없음`);
      else if ((target as BaseRow).deletedAt != null)
        push(issues, 'SOFT_DELETED_PARENT_REF', child, row.id, `${field}=${ref} → ${parent} 삭제됨(활성 자식 잔존)`);
    }
  }

  // ④ 활성 중복(partial unique 실측)
  for (const { table, keys, ci } of ACTIVE_UNIQUE) {
    const seen = new Map<string, number>();
    for (const row of rows<BaseRow & Record<string, unknown>>(table)) {
      const parts = keys.map((k) => row[k]);
      if (parts.some((v) => v == null || v === '')) continue;
      const key = parts.map((v) => (ci ? String(v).toLowerCase() : String(v))).join('¦');
      const prior = seen.get(key);
      if (prior != null) push(issues, 'ACTIVE_DUPLICATE', table, row.id, `(${keys.join(',')})=(${key}) — 중복 상대 id ${prior}`);
      else seen.set(key, row.id);
    }
  }

  // ⑤ 시퀀스 드리프트 — information_schema 자동 탐색(테이블 목록 하드코딩 없음)
  const serials = await pg.query<{ table_name: string; seq: string | null }>(
    `SELECT c.table_name, pg_get_serial_sequence(c.table_name, 'id') AS seq
       FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name='id' AND c.column_default LIKE 'nextval%'`,
  );
  for (const { table_name, seq } of serials) {
    if (!seq) continue;
    const [{ m }] = await pg.query<{ m: string }>(`SELECT COALESCE(MAX(id),0)::bigint AS m FROM ${table_name}`);
    const [{ last_value, is_called }] = await pg.query<{ last_value: string; is_called: boolean }>(`SELECT last_value, is_called FROM ${seq}`);
    const next = Number(last_value) + (is_called ? 1 : 0);
    if (Number(m) >= next) push(issues, 'SEQUENCE_DRIFT', table_name, undefined, `max(id)=${m} ≥ 시퀀스 next=${next} — 삽입 충돌 예고`);
  }

  // ⑥ 재무 역참조 배타 — transactions는 payment/payout/expense 역참조가 둘 이상이면 위반(erd 앱단 CHECK),
  //    정산 계열 category는 payoutId 필수.
  for (const tx of rows<BaseRow & { paymentId?: number | null; payoutId?: number | null; expenseId?: number | null; category?: string }>('transactions')) {
    const refs = [tx.paymentId, tx.payoutId, tx.expenseId].filter((v) => v != null).length;
    if (refs > 1) push(issues, 'TX_BACKREF_NOT_EXCLUSIVE', 'transactions', tx.id, `역참조 ${refs}개(정확히 하나 규약)`);
    if ((tx.category === 'instructor_payout' || tx.category === 'payout_reversal') && tx.payoutId == null)
      push(issues, 'TX_PAYOUT_REF_MISSING', 'transactions', tx.id, `category=${tx.category}인데 payoutId 없음`);
  }

  // ⑧ [TBO-31 C5 D10] emailVerified 불변식 — 계정 생성 전 경로(OTP 가입·승인 tx·직접 등록·시드)는
  //    전부 true로 생성한다(컬럼 기본값 false는 방어선일 뿐). false 행 존재 = 레거시 잔재 또는
  //    비정상 생성 경로의 증거이므로 위반으로 보고한다(소프트 삭제 행은 제외).
  for (const account of rows<BaseRow & { emailVerified?: boolean; webId?: string; status?: string }>('users')) {
    if (account.emailVerified !== true)
      push(issues, 'EMAIL_VERIFIED_INVARIANT', 'users', account.id, `email_verified=${String(account.emailVerified)} (status=${account.status ?? '?'}) — 계정 레코드는 항상 true`);
  }

  // ⑩ [TBO-35 35C] 학생 희망 수업 aggregate 불변. 신규/수정 command는 항상 2개 이상을 강제하지만
  //  35B expand 이전 legacy 학생은 reset/constrain 전까지 0개일 수 있어 warning으로 계측한다.
  //  35F cleanup 후 warning 0을 확인하고 hard issue로 승격한다.
  {
    const interests = rows<BaseRow & { studentId: number; courseId?: number | null; customLabel?: string | null; priority: number }>('student_interests');
    const byStudent = new Map<number, typeof interests>();
    for (const interest of interests) {
      if (!byStudent.has(interest.studentId)) byStudent.set(interest.studentId, []);
      byStudent.get(interest.studentId)!.push(interest);
      const custom = interest.customLabel?.trim();
      if ((interest.courseId != null) === !!custom)
        push(issues, 'STUDENT_INTEREST_TARGET', 'student_interests', interest.id, 'courseId/customLabel 중 정확히 하나 필요');
      if (!Number.isInteger(interest.priority) || interest.priority < 1)
        push(issues, 'STUDENT_INTEREST_PRIORITY', 'student_interests', interest.id, `priority=${interest.priority}`);
    }
    const customSeen = new Map<string, number>();
    for (const interest of interests) {
      const custom = interest.customLabel?.trim().toLowerCase();
      if (!custom) continue;
      const key = `${interest.studentId}¦${custom}`;
      const prior = customSeen.get(key);
      if (prior != null) push(issues, 'STUDENT_INTEREST_CUSTOM_DUPLICATE', 'student_interests', interest.id, `학생 ${interest.studentId} custom 중복 상대 id ${prior}`);
      else customSeen.set(key, interest.id);
    }
    for (const student of rows('students')) {
      const owned = byStudent.get(student.id) ?? [];
      const count = owned.length;
      if (count < 2) push(warnings, 'STUDENT_INTEREST_MINIMUM_LEGACY', 'students', student.id, `활성 관심 수업 ${count}개 — 35F cleanup 대상`);
      const priorities = owned.map((row) => row.priority).sort((a, b) => a - b);
      if (priorities.some((priority, index) => priority !== index + 1))
        push(issues, 'STUDENT_INTEREST_PRIORITY_GAP', 'students', student.id, `priority=${priorities.join(',')}`);
    }
  }

  // ⑨ [TBO-32 C3 2026-07-22] 정산 무결성 검사군 (a)~(f) — 순수 함수(payout-integrity.ts) 단일
  //    진실원을 소비(음성 검증 e2e와 동일 코드 경로). 기간 중첩은 경고(정당 사례 존재).
  {
    const result = checkPayoutIntegrity({
      payouts: rows('instructor_payouts') as never,
      transactions: rows('transactions') as never,
      sessions: rows('class_sessions') as never,
    });
    issues.push(...result.issues);
    warnings.push(...result.warnings);
  }

  // ⑨(선행분) [TBO-32 C1 2026-07-20] 세션 지급 플래그 정합 — is_paid ⇔ 연결 정산서 paid.
  //    is_paid=true인데 payout_id NULL/비paid = 드리프트(measure fail-safe가 재계상은 막지만 보고).
  //    paid 정산서의 lines 세션인데 is_paid=false = 지급 플래그 누락. paid_payout_id는 이력 컬럼
  //    (회수 후에도 잔존)이라 검사하지 않는다. 전체 ⑨ 검사군(명세 합계·원장 1:1 등)은 TBO-32 C3.
  {
    const payoutById = new Map(rows<BaseRow & { status?: string; lines?: Array<{ sessionId: number }> }>('instructor_payouts').map((row) => [row.id, row]));
    const sessionsById = new Map(rows<BaseRow & { isPaid?: boolean; payoutId?: number | null }>('class_sessions').map((row) => [row.id, row]));
    for (const session of sessionsById.values()) {
      if (session.isPaid === true) {
        const linked = session.payoutId != null ? payoutById.get(Number(session.payoutId)) : undefined;
        if (!linked) push(issues, 'SESSION_PAID_FLAG_ORPHAN', 'class_sessions', session.id, `is_paid=true인데 payout_id=${session.payoutId ?? 'NULL'} — 연결 정산서 없음`);
        else if (linked.status !== 'paid') push(issues, 'SESSION_PAID_FLAG_MISMATCH', 'class_sessions', session.id, `is_paid=true인데 정산서 ${linked.id} status=${linked.status}`);
      }
    }
    for (const [payoutId, payout] of payoutById) {
      if (payout.status !== 'paid') continue;
      for (const line of payout.lines ?? []) {
        const session = sessionsById.get(line.sessionId);
        if (session && (session.isPaid !== true || Number(session.payoutId) !== payoutId))
          push(issues, 'SESSION_PAID_FLAG_MISSING', 'class_sessions', line.sessionId, `paid 정산서 ${payoutId}의 세션인데 is_paid=${String(session.isPaid)}/payout_id=${session.payoutId ?? 'NULL'}`);
      }
    }
  }

  // ⑦ 감사 신호(경고) — 감사 원칙 대상 테이블에 행이 있는데 audit_log 0건(역사적 데이터 허용 — 실패 아님)
  // audit_log는 durable 모드에서 skipMemoryWhenDurable=true라 메모리 컬렉션이 의도적으로 비어 있다.
  // 감사 존재/건수는 반드시 PostgreSQL을 직접 읽어 false warning/count를 만들지 않는다.
  const persistedAuditEntities = await pg.query<{ entity: string }>('SELECT DISTINCT entity FROM audit_log');
  const auditEntities = new Set(persistedAuditEntities.map((row) => row.entity));
  for (const { table_name } of serials) {
    if (AUDIT_EXCLUDED.has(table_name) || auditEntities.has(table_name)) continue;
    const [{ n }] = await pg.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM ${table_name} WHERE deleted_at IS NULL`);
    if (Number(n) > 0) push(warnings, 'AUDIT_SILENT_TABLE', table_name, undefined, `활성 ${n}행인데 audit_log 이력 0건(시드/역사 데이터면 정상)`);
  }

  const countedTables = [
    'users', 'students', 'student_interests', 'class_sessions', 'attendance',
    'session_reports', 'payments', 'expenses', 'transactions', 'instructor_payouts',
  ];
  // counts는 복원/감사 근거인 soft-delete 행까지 포함한 물리 이력 수를 하위 호환으로 유지한다.
  // activeCounts를 함께 노출해 운영 데이터 0과 이력 보존을 혼동하지 않게 한다.
  const counts = Object.fromEntries(countedTables.map((t) => [t, rows(t, true).length]));
  const activeCounts = Object.fromEntries(countedTables.map((t) => [t, rows(t).length]));
  const [{ n: auditCount }] = await pg.query<{ n: string }>('SELECT COUNT(*)::int AS n FROM audit_log');
  counts.audit_log = Number(auditCount);
  activeCounts.audit_log = Number(auditCount);
  const ok = issues.length === 0;
  console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), counts, activeCounts, issues, warnings }, null, 2));
  if (!ok) process.exitCode = 1;
  await app.close();
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  process.exitCode = 1;
});
