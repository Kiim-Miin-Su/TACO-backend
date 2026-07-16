// [B9 E5 2026-07-16] DB 무결성 전수 검증 — 읽기 전용(데이터 쓰기 0; 부팅 멱등 DDL만, 기존 스키마 no-op).
//  이 코드베이스는 재무 역참조·polymorphic 참조를 의도적으로 DB FK 미강제(앱단 검증 — erd.dbml 명문)
//  하므로, 그 앱단 규칙을 실 DB에서 실측하는 게 이 스크립트의 존재 이유다.
//  검사군: ① 회계 정합(checkAccountingIntegrity 재사용 — reversal 규칙 포함) ② 앱단 FK 고아
//  ③ soft delete 정합(삭제된 부모를 활성 자식이 참조) ④ partial unique 실측(활성 중복)
//  ⑤ 시퀀스 드리프트(information_schema 자동 탐색) ⑥ 재무 역참조 배타 ⑦ 감사 신호(경고 — 실패 아님).
//  사용: DATABASE_URL=... npx ts-node? → 아니오: nest build 후 `npm run db:integrity`.
//  출력: JSON { ok, checkedAt, counts, issues[], warnings[] } · issues>0 → exitCode 1.
import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../test/setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { checkAccountingIntegrity, type AccountingIntegritySnapshot } from '../src/modules/payouts/accounting-integrity';
import type { BaseRow } from '../src/common/types/base';

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
  { child: 'parent_relations', field: 'parentId', parent: 'parents' },
  { child: 'parent_relations', field: 'studentId', parent: 'students' },
  { child: 'counsel_forms', field: 'interestSubjectId', parent: 'subjects' },
  { child: 'counsel_forms', field: 'interestCourseId', parent: 'courses' },
  { child: 'counsel_rounds', field: 'counselFormId', parent: 'counsel_forms' },
  { child: 'session_reports', field: 'subjectId', parent: 'subjects' },
  { child: 'courses', field: 'subjectId', parent: 'subjects' },
  { child: 'instructor_payouts', field: 'instructorId', parent: 'users' },
];

// 활성 중복 검사(partial unique 실측) — DB 인덱스가 있는 것도 실측(인덱스 누락 배포 감시 겸용).
const ACTIVE_UNIQUE: Array<{ table: string; keys: string[]; ci?: boolean }> = [
  { table: 'attendance', keys: ['sessionId', 'studentId'] },
  { table: 'session_reports', keys: ['sessionId', 'studentId'] },
  { table: 'nav_seen_states', keys: ['userId', 'navKey'] },
  { table: 'calendar_view_presets', keys: ['name'] },
  { table: 'users', keys: ['webId'], ci: true },
  { table: 'users', keys: ['email'], ci: true },
];

// 감사 원칙 대상에서 제외되는 테이블(erd.dbml audit_log Note 단일 소스와 동일).
const AUDIT_EXCLUDED = new Set([
  'audit_log', 'auth_events', 'auth_refresh_tokens', 'profile_verification_challenges',
  'countries', 'instructor_contracts', 'nav_seen_states',
]);

async function main() {
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

  // ⑦ 감사 신호(경고) — 감사 원칙 대상 테이블에 행이 있는데 audit_log 0건(역사적 데이터 허용 — 실패 아님)
  const auditEntities = new Set(rows<BaseRow & { entity: string }>('audit_log', true).map((a) => a.entity));
  for (const { table_name } of serials) {
    if (AUDIT_EXCLUDED.has(table_name) || auditEntities.has(table_name)) continue;
    const [{ n }] = await pg.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM ${table_name} WHERE deleted_at IS NULL`);
    if (Number(n) > 0) push(warnings, 'AUDIT_SILENT_TABLE', table_name, undefined, `활성 ${n}행인데 audit_log 이력 0건(시드/역사 데이터면 정상)`);
  }

  const counts = Object.fromEntries(
    ['users', 'students', 'class_sessions', 'attendance', 'session_reports', 'payments', 'expenses', 'transactions', 'instructor_payouts', 'audit_log']
      .map((t) => [t, rows(t, true).length]),
  );
  const ok = issues.length === 0;
  console.log(JSON.stringify({ ok, checkedAt: new Date().toISOString(), counts, issues, warnings }, null, 2));
  if (!ok) process.exitCode = 1;
  await app.close();
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
  process.exitCode = 1;
});
