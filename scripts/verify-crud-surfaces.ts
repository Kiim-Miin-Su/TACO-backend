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
  users: { lifecycle: 'direct', contract: ['Account'], api: ['GET /users', 'PATCH /users/{id}'], frontend: ['api.users', 'UsersView'], verdict: 'complete', note: 'account/admin aggregate CRUD' },
  countries: { lifecycle: 'reference', contract: ['Country'], api: ['GET /catalog/countries'], frontend: ['api.catalog.countries'], verdict: 'by-design', note: 'seeded read-only reference' },
  instructor_profiles: { lifecycle: 'aggregate-child', contract: ['InstructorAggregate'], api: ['GET /instructors/{id}', 'PATCH /instructors/{id}'], frontend: ['api.instructors'], verdict: 'complete', note: 'instructor aggregate owns writes' },
  auth_events: { lifecycle: 'append-only', verdict: 'gap', note: 'writes exist; admin login-history read/search surface missing' },
  auth_rate_limits: { lifecycle: 'system', verdict: 'by-design', note: 'server throttle state; user CRUD forbidden' },
  nav_seen_states: { lifecycle: 'direct', api: ['GET /nav-seen', 'PUT /nav-seen'], frontend: ['api.navSeen'], verdict: 'complete', note: 'per-user read/update state' },
  auth_refresh_tokens: { lifecycle: 'system', api: ['POST /auth/refresh', 'POST /auth/logout'], verdict: 'by-design', note: 'rotation/revoke command only' },
  profile_change_requests: { lifecycle: 'direct', api: ['POST /profile-change-requests', 'GET /profile-change-requests/{id}'], frontend: ['api.profileChangeRequests'], verdict: 'gap', note: 'frontend/backend local DTO plus create/read/decision; shared contract and requester withdraw missing' },
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
  attendance: { lifecycle: 'direct', contract: ['Attendance'], api: ['GET /attendance', 'PUT /attendance'], frontend: ['api.attendance'], verdict: 'gap', note: 'upsert exists; accidental student attendance clear command/UI missing' },
  rooms: { lifecycle: 'direct', contract: ['Room'], api: ['POST /rooms', 'PATCH /rooms/{id}', 'DELETE /rooms/{id}'], frontend: ['api.rooms'], verdict: 'complete', note: 'resource CRUD' },
  availability_blocks: { lifecycle: 'direct', contract: ['AvailabilityBlock'], api: ['PUT /availability', 'DELETE /availability/{id}'], frontend: ['api.availability'], verdict: 'complete', note: 'upsert/delete plus approval path' },
  instructor_payouts: { lifecycle: 'direct', contract: ['InstructorPayout'], api: ['POST /payouts/generate', 'POST /payouts/{id}/pay'], frontend: ['api.payouts'], verdict: 'complete', note: 'finance state machine; direct delete forbidden' },
  instructor_contracts: { lifecycle: 'direct', api: ['GET /instructor-contracts'], frontend: ['api.instructorContracts'], verdict: 'gap', note: 'shared contract and CEO create/update/end surface missing' },
  expenses: { lifecycle: 'direct', contract: ['Expense'], api: ['POST /expenses', 'PATCH /expenses/{id}', 'DELETE /expenses/{id}'], frontend: ['api.expenses'], verdict: 'complete', note: 'request/decision lifecycle' },
  transactions: { lifecycle: 'derived', contract: ['Transaction'], api: ['GET /transactions'], frontend: ['api.transactions'], verdict: 'by-design', note: 'payment/expense/payout transition-owned ledger; direct CUD forbidden' },
  academy_events: { lifecycle: 'direct', contract: ['AcademyEvent'], api: ['POST /events', 'PATCH /events/{id}', 'DELETE /events/{id}'], frontend: ['api.events'], verdict: 'complete', note: 'calendar event CRUD' },
  session_reports: { lifecycle: 'direct', contract: ['SessionReport'], api: ['POST /reports', 'PATCH /reports/{id}', 'POST /reports/{id}/approve'], frontend: ['api.reports'], verdict: 'gap', note: 'draft correction exists; mistaken draft withdraw/delete command missing' },
  calendar_view_presets: { lifecycle: 'direct', contract: ['CalendarViewPreset'], api: ['POST /view-presets', 'PATCH /view-presets/{id}', 'DELETE /view-presets/{id}'], frontend: ['api.viewPresets'], verdict: 'complete', note: 'owner-scoped persisted CRUD' },
  report_templates: { lifecycle: 'direct', contract: ['ReportTemplate'], api: ['POST /report-templates', 'DELETE /report-templates/{id}'], frontend: ['api.reportTemplates'], verdict: 'gap', note: 'create/read/delete exists; update missing' },
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

function sourceUnder(path: string): string {
  return filesUnder(path)
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
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
  const frontend = sourceUnder(resolve(workspace, 'frontend'));
  const openapi = JSON.parse(readFileSync(resolve(root, 'openapi.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const errors: string[] = [];
  if (missing.length) errors.push(`manifest missing DB tables: ${missing.join(', ')}`);
  if (extra.length) errors.push(`manifest-only tables: ${extra.join(', ')}`);

  for (const [table, surface] of Object.entries(S)) {
    for (const marker of surface.contract ?? []) {
      if (!contracts.includes(marker)) errors.push(`${table}: missing contract marker ${marker}`);
    }
    for (const operation of surface.api ?? []) {
      const [method, path] = operation.split(' ');
      const apiPath = path.startsWith('/api/') ? path : `/api${path}`;
      if (!openapi.paths[apiPath]?.[method.toLowerCase()]) errors.push(`${table}: missing OpenAPI ${operation}`);
    }
    for (const marker of surface.frontend ?? []) {
      if (!frontend.includes(marker)) errors.push(`${table}: missing frontend marker ${marker}`);
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
