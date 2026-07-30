import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

type Lifecycle = 'direct' | 'aggregate-child' | 'reference' | 'system' | 'append-only' | 'derived';
type Verdict = 'complete' | 'by-design' | 'gap';
type Surface = {
  lifecycle: Lifecycle;
  contract?: string[];
  api?: string[];
  frontend?: string[];
  verdict: Verdict;
  note: string;
};

const S: Record<string, Surface> = {
  schema_migrations: { lifecycle: 'system', verdict: 'by-design', note: 'migration ledger; user CRUD forbidden' },
  signup_email_challenges: { lifecycle: 'system', api: ['POST /auth/signup-email-challenge'], verdict: 'by-design', note: 'OTP command lifecycle' },
  signup_phone_challenges: { lifecycle: 'system', api: ['POST /auth/signup-phone-challenge'], verdict: 'by-design', note: 'OTP command lifecycle' },
  users: {
    lifecycle: 'direct',
    contract: ['Account'],
    api: ['GET /users', 'PATCH /users/{id}', 'DELETE /users/{id}', 'POST /users/{id}/restore'],
    frontend: ['api.users', 'UsersView', 'useTerminateUser', 'useRestoreUser'],
    verdict: 'complete',
    note: 'account/admin aggregate CRUD plus executive-only atomic termination/restore',
  },
  countries: { lifecycle: 'reference', contract: ['Country'], api: ['GET /catalog/countries'], frontend: ['api.catalog.countries'], verdict: 'by-design', note: 'seeded read-only reference' },
  instructor_profiles: { lifecycle: 'aggregate-child', contract: ['InstructorAggregate'], api: ['GET /instructors/{id}', 'PATCH /instructors/{id}'], frontend: ['api.instructors'], verdict: 'complete', note: 'instructor aggregate owns writes' },
  auth_events: {
    lifecycle: 'append-only',
    contract: ['AuthEventRecord', 'AuthEventQuery'],
    api: ['GET /auth/events'],
    frontend: ['api.authEvents', 'useAuthEvents'],
    verdict: 'complete',
    note: 'server-only append; CEO/admin sudo bounded read/search; update/delete forbidden',
  },
  auth_rate_limits: { lifecycle: 'system', verdict: 'by-design', note: 'server throttle state; user CRUD forbidden' },
  nav_seen_states: { lifecycle: 'direct', api: ['GET /nav-seen', 'PUT /nav-seen'], frontend: ['api.navSeen'], verdict: 'complete', note: 'per-user read/update state' },
  auth_refresh_tokens: { lifecycle: 'system', api: ['POST /auth/refresh', 'POST /auth/logout'], verdict: 'by-design', note: 'rotation/revoke command only' },
  profile_change_requests: {
    lifecycle: 'direct',
    contract: ['ProfileChangeRequest', 'CreateProfileChangeRequestInput'],
    api: ['POST /profile-change-requests', 'GET /profile-change-requests/{id}', 'DELETE /profile-change-requests/{id}'],
    frontend: ['api.profileChangeRequests', 'useWithdrawProfileChangeRequest'],
    verdict: 'complete',
    note: 'shared contract plus create/read/decision/requester soft-delete withdraw and audit',
  },
  profile_verification_challenges: { lifecycle: 'system', api: ['POST /profile-verifications'], verdict: 'by-design', note: 'verification command lifecycle' },
  parents: { lifecycle: 'direct', contract: ['Parent'], api: ['POST /parents', 'PATCH /parents/{id}'], frontend: ['api.parents'], verdict: 'complete', note: 'guardian master CRUD' },
  students: { lifecycle: 'direct', contract: ['Student'], api: ['POST /students/registrations', 'PATCH /students/{id}'], frontend: ['api.students', 'StudentDetailView'], verdict: 'complete', note: 'status lifecycle plus privileged soft delete' },
  student_interests: { lifecycle: 'aggregate-child', contract: ['StudentInterest'], api: ['POST /students/{studentId}/interests'], frontend: ['updateAggregate'], verdict: 'complete', note: 'student aggregate nested CRUD' },
  student_academic_histories: { lifecycle: 'aggregate-child', contract: ['StudentAcademicHistory'], api: ['POST /students/{id}/academic-histories'], frontend: ['createAcademicHistory'], verdict: 'complete', note: 'student timeline nested CRUD' },
  parent_student_relations: { lifecycle: 'aggregate-child', contract: ['ParentStudent'], api: ['POST /parents/link'], frontend: ['api.parents'], verdict: 'complete', note: 'guardian relation nested CRUD' },
  student_family_relations: { lifecycle: 'aggregate-child', contract: ['StudentFamilyRelation'], api: ['POST /students/{id}/family-relations'], frontend: ['createFamilyRelation'], verdict: 'complete', note: 'student family aggregate CRUD' },
  subjects: { lifecycle: 'direct', contract: ['Subject'], api: ['POST /subjects', 'PATCH /subjects/{id}', 'DELETE /subjects/{id}'], frontend: ['api.subjects'], verdict: 'complete', note: 'catalog CRUD' },
  courses: { lifecycle: 'direct', contract: ['Course'], api: ['POST /courses', 'PATCH /courses/{id}', 'DELETE /courses/{id}'], frontend: ['api.courses'], verdict: 'complete', note: 'catalog CRUD' },
  roadmaps: { lifecycle: 'direct', contract: ['Roadmap'], api: ['POST /roadmaps', 'PATCH /roadmaps/{id}', 'DELETE /roadmaps/{id}'], frontend: ['api.roadmaps'], verdict: 'complete', note: 'catalog aggregate CRUD' },
  roadmap_courses: { lifecycle: 'aggregate-child', contract: ['Roadmap'], api: ['POST /roadmaps/{id}/courses', 'DELETE /roadmaps/{id}/courses/{courseId}'], frontend: ['addCourse', 'removeCourse'], verdict: 'complete', note: 'roadmap aggregate nested CRUD/order' },
  counsel_forms: { lifecycle: 'direct', contract: ['CounselForm'], api: ['POST /counsel', 'PATCH /counsel/{id}', 'DELETE /counsel/{id}'], frontend: ['api.counsel'], verdict: 'complete', note: 'counsel CRUD/detail' },
  counsel_rounds: { lifecycle: 'aggregate-child', contract: ['CounselRound'], api: ['POST /counsel/{id}/rounds', 'PATCH /counsel/{id}/rounds/{roundId}'], frontend: ['createRound', 'updateRound'], verdict: 'complete', note: 'counsel aggregate nested CRUD' },
  enrollments: { lifecycle: 'direct', contract: ['UpdateEnrollmentInput'], api: ['POST /enrollments', 'PATCH /enrollments/{id}'], frontend: ['useUpdateEnrollment', 'EnrollmentStatusChangeModal'], verdict: 'complete', note: 'status transition is business delete; history retained' },
  schedule_requests: { lifecycle: 'direct', contract: ['ScheduleRequest'], api: ['POST /schedule-requests', 'PATCH /schedule-requests/{id}', 'DELETE /schedule-requests/{id}'], frontend: ['api.scheduleRequests'], verdict: 'complete', note: 'request/decision/withdraw lifecycle' },
  audit_log: { lifecycle: 'append-only', contract: ['AuditLog'], api: ['GET /audit'], frontend: ['api.audit'], verdict: 'by-design', note: 'service-boundary append and admin read; update/delete forbidden' },
  payments: { lifecycle: 'direct', contract: ['Payment'], api: ['POST /payments', 'PATCH /payments/{id}', 'POST /payments/{id}/refund'], frontend: ['api.payments'], verdict: 'complete', note: 'state machine replaces direct delete' },
  class_session_series: { lifecycle: 'aggregate-child', contract: ['ScheduleSeries'], api: ['POST /schedule/series'], frontend: ['createSeries'], verdict: 'complete', note: 'schedule aggregate scope commands' },
  class_sessions: { lifecycle: 'direct', contract: ['ClassSession'], api: ['POST /schedule', 'PATCH /schedule/{id}', 'DELETE /schedule/{id}'], frontend: ['api.schedule'], verdict: 'complete', note: 'calendar CRUD/restore/scope' },
  attendance: {
    lifecycle: 'direct',
    contract: ['Attendance', 'UpsertAttendanceInput', 'ClearAttendanceInput'],
    api: ['GET /attendance', 'PUT /attendance', 'DELETE /attendance/{sessionId}/{studentId}'],
    frontend: ['api.attendance', 'useClearAttendance'],
    verdict: 'complete',
    note: 'owner/admin upsert and reasoned clear; audit plus held-to-scheduled transition',
  },
  rooms: { lifecycle: 'direct', contract: ['Room'], api: ['POST /rooms', 'PATCH /rooms/{id}', 'DELETE /rooms/{id}'], frontend: ['api.rooms'], verdict: 'complete', note: 'resource CRUD' },
  availability_blocks: { lifecycle: 'direct', contract: ['AvailabilityBlock'], api: ['PUT /availability', 'DELETE /availability/{id}'], frontend: ['api.availability'], verdict: 'complete', note: 'upsert/delete plus approval path' },
  instructor_payouts: { lifecycle: 'direct', contract: ['InstructorPayout'], api: ['POST /payouts/generate', 'POST /payouts/{id}/pay'], frontend: ['api.payouts'], verdict: 'complete', note: 'finance state machine; direct delete forbidden' },
  instructor_contracts: {
    lifecycle: 'direct',
    contract: ['InstructorContract', 'CreateInstructorContractInput', 'UpdateInstructorContractInput'],
    api: ['GET /instructor-contracts', 'GET /instructor-contracts/{id}', 'POST /instructor-contracts', 'PATCH /instructor-contracts/{id}'],
    frontend: ['api.instructorContracts', 'InstructorContractModal'],
    verdict: 'complete',
    note: 'CEO-only sudo create/update/end; audit plus FK/CHECK/active-period exclusion',
  },
  expenses: { lifecycle: 'direct', contract: ['Expense'], api: ['POST /expenses', 'PATCH /expenses/{id}', 'DELETE /expenses/{id}'], frontend: ['api.expenses'], verdict: 'complete', note: 'request/decision lifecycle' },
  transactions: { lifecycle: 'derived', contract: ['Transaction'], api: ['GET /transactions'], frontend: ['api.transactions'], verdict: 'by-design', note: 'payment/expense/payout transition-owned ledger; direct CUD forbidden' },
  academy_events: { lifecycle: 'direct', contract: ['AcademyEvent'], api: ['POST /events', 'PATCH /events/{id}', 'DELETE /events/{id}'], frontend: ['api.events'], verdict: 'complete', note: 'calendar event CRUD' },
  session_reports: {
    lifecycle: 'direct',
    contract: ['SessionReport'],
    api: ['POST /reports', 'PATCH /reports/{id}', 'DELETE /reports/{id}', 'POST /reports/{id}/approve'],
    frontend: ['api.reports', 'useRemoveReport'],
    verdict: 'complete',
    note: 'draft owner/admin soft-delete plus submission/decision lifecycle and audit',
  },
  calendar_view_presets: { lifecycle: 'direct', contract: ['CalendarViewPreset'], api: ['POST /view-presets', 'PATCH /view-presets/{id}', 'DELETE /view-presets/{id}'], frontend: ['api.viewPresets'], verdict: 'complete', note: 'owner-scoped persisted CRUD' },
  report_templates: {
    lifecycle: 'direct',
    contract: ['ReportTemplate', 'CreateReportTemplateInput', 'UpdateReportTemplateInput'],
    api: ['POST /report-templates', 'PATCH /report-templates/{id}', 'DELETE /report-templates/{id}'],
    frontend: ['api.reportTemplates', 'useUpdateReportTemplate'],
    verdict: 'complete',
    note: 'shared read/apply; creator or admin update/delete with persisted owner',
  },
};

const root = resolve(__dirname, '..');
const workspace = resolve(root, '..');

function filesUnder(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name === '.git') return [];
    const child = resolve(path, name);
    return statSync(child).isDirectory() ? filesUnder(child) : [child];
  });
}

// [TBO-79 F1] 종전엔 소스 전체를 이어붙인 문자열에 대한 substring 포함 검사였다. 그래서
//  ① 부분 문자열 충돌이 통과하고(`Country`가 `paneCountryInstructor`에 걸림 — 공유 Country
//     타입은 존재하지도 않는데 게이트는 초록이었다)
//  ② 테스트 파일에만 등장하는 심볼도 통과했다(sourceUnder가 .test.ts를 포함).
//  게이트가 결손을 볼 수 없으면 게이트 통과는 증거가 아니다. 아래 두 헬퍼로 교체한다.
function sourceFilesUnder(path: string, opts: { includeTests: boolean }): string[] {
  return filesUnder(path).filter((file) => {
    if (!/\.(ts|tsx)$/.test(file)) return false;
    if (opts.includeTests) return true;
    return !/\.(test|spec)\.tsx?$/.test(file) && !/\/__tests__\//.test(file);
  });
}

function sourceUnder(path: string, opts: { includeTests: boolean } = { includeTests: false }): string {
  return sourceFilesUnder(path, opts).map((file) => readFileSync(file, 'utf8')).join('\n');
}

/** 계약 marker = 실제 `export type|interface|const|enum <marker>` 선언이 있어야 한다. */
function declaresExport(source: string, marker: string): boolean {
  const name = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`export\\s+(?:declare\\s+)?(?:type|interface|const|enum|class|function)\\s+${name}\\b`).test(source);
}

/** 프론트 marker = 단어 경계로 실제 참조돼야 한다(부분 문자열 충돌 차단). */
function referencesSymbol(source: string, marker: string): boolean {
  // `api.students` 같은 점 표기는 그대로, 식별자는 단어 경계로 묶는다.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(source);
}

function dbmlTables(source: string): string[] {
  return [...source.matchAll(/^Table\s+([a-z][a-z0-9_]*)\s*\{/gm)].map((match) => match[1]).sort();
}

function main(): void {
  const dbml = dbmlTables(readFileSync(resolve(workspace, 'docs/erd.dbml'), 'utf8'));
  const manifest = Object.keys(S).sort();
  const missing = dbml.filter((table) => !S[table]);
  const extra = manifest.filter((table) => !dbml.includes(table));
  const contracts = sourceUnder(resolve(workspace, 'contracts/src'));
  // [TBO-79 F1] 프론트 marker는 **제품 코드**에서만 찾는다 — 테스트에만 남은 사문 심볼이
  //  표면 존재의 증거가 되면 안 된다.
  const frontend = sourceUnder(resolve(workspace, 'frontend'));
  const openapi = JSON.parse(readFileSync(resolve(root, 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const errors: string[] = [];
  if (missing.length) errors.push(`manifest missing DB tables: ${missing.join(', ')}`);
  if (extra.length) errors.push(`manifest-only tables: ${extra.join(', ')}`);

  for (const [table, surface] of Object.entries(S)) {
    for (const marker of surface.contract ?? []) {
      if (!declaresExport(contracts, marker)) {
        errors.push(`${table}: contract marker ${marker} has no exported declaration in contracts/src`);
      }
    }
    for (const operation of surface.api ?? []) {
      const [method, path] = operation.split(' ');
      const apiPath = path.startsWith('/api/') ? path : `/api${path}`;
      if (!openapi.paths[apiPath]?.[method.toLowerCase()]) errors.push(`${table}: missing OpenAPI ${operation}`);
    }
    for (const marker of surface.frontend ?? []) {
      if (!referencesSymbol(frontend, marker)) {
        errors.push(`${table}: frontend marker ${marker} is not referenced in product code`);
      }
    }
  }

  const lifecycleCounts = Object.values(S).reduce<Record<string, number>>((out, row) => {
    out[row.lifecycle] = (out[row.lifecycle] ?? 0) + 1;
    return out;
  }, {});
  const gaps = Object.entries(S).filter(([, row]) => row.verdict === 'gap');
  console.log(JSON.stringify({
    ok: errors.length === 0,
    physicalTables: dbml.length,
    manifestTables: manifest.length,
    lifecycleCounts,
    gaps: gaps.map(([table, row]) => ({ table, note: row.note })),
    errors,
  }, null, 2));
  if (errors.length) process.exit(1);
}

main();
