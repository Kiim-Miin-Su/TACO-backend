import { INestApplication } from '@nestjs/common';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app'; // [74D-1] SudoGuard 라우트는 Bearer+sudo cookie 필수
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { normalizeQueryRows } from '../src/database/postgres-row.util';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersService } from '../src/modules/users/users.service';
import { studentAggregateBody } from './fixtures/student-profile';

const enabled = process.env.RUN_DB_CRUD_E2E === '1';
const describeDb = enabled ? describe : describe.skip;

// [TBO-29C C5] 실 Neon(WAN) 재시작 시나리오 — 부팅×N + 권위 재수화가 왕복 지연을 그대로 받는
//  장기 실행 스위트라 상향(로컬 PG는 수 초 내 완료). 개별 시나리오가 300s를 넘으면 그건 회귀다.
jest.setTimeout(300_000);

type AvailabilityRow = {
  id: number;
  ownerType: string;
  ownerId: number;
  kind: string;
  weekday: number;
  startTime: string;
  endTime: string;
  effectiveFrom?: string;
  effectiveTo?: string;
};

type ViewPresetRow = {
  id: number;
  name: string;
  view: string;
  instructorIds: number[];
  studentIds: number[];
  roomIds: number[];
  manualPanes?: Array<Record<string, unknown>>;
};

type AuditRow = {
  id: number;
  entity: string;
  entityId: number;
  action: string;
  actorId: number;
  changes?: Record<string, unknown>;
};

type ScheduleRow = {
  id: number;
  sessionDate: string;
  topic?: string;
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let managerActorId = 0;
let ceoActorId = 0;
let qaInstructorId = 0;
let qaStudentId = 0;
let qaRelatedStudentId = 0;
let qaCounselId = 0;
let qaSubjectId = 0;
let qaRoomId = 0;
let qaCourseId = 0;
const qaAvailabilityIds = new Set<number>();
const qaPresetIds = new Set<number>();
const qaSessionIds = new Set<number>();
const openApps = new Set<INestApplication>();

function tokenFor(app: INestApplication, actorId: number): string {
  const account = app.get(UsersService).findById(actorId);
  if (!account || account.status !== 'active' || account.deletedAt != null) {
    throw new Error(`DB CRUD actor ${actorId} is not active`);
  }
  return app.get(AuthService).sign({
    sub: account.id,
    name: account.name,
    roles: [account.role],
    authVersion: account.authVersion ?? 1,
    mustChangePassword: account.mustChangePassword ?? false,
  });
}

async function boot(): Promise<{ app: INestApplication; http: ReturnType<typeof request>; manager: string; ceo: string }> {
  const app = await createTestApp();
  openApps.add(app);
  const pg = app.get(PostgresConnectionService);
  expect(pg.ready).toBe(true);
  const http = request(app.getHttpServer());
  return {
    app,
    http,
    manager: tokenFor(app, managerActorId),
    ceo: tokenFor(app, ceoActorId),
  };
}

async function closeApp(app: INestApplication): Promise<void> {
  openApps.delete(app);
  await app.close();
}

async function fallbackSoftDelete(
  pg: PostgresConnectionService,
  table: string,
  whereSql: string,
  params: unknown[],
  actorId: number,
  extraSet = '',
  idColumn = 'id',
): Promise<void> {
  const rows = normalizeQueryRows<{ id: number }>(await pg.query(
    `UPDATE ${table}
        SET ${extraSet}${extraSet ? ', ' : ''}deleted_at=now(), deleted_by=$1, updated_at=now()
      WHERE ${whereSql} AND deleted_at IS NULL
      RETURNING ${idColumn} AS id`,
    [actorId, ...params],
  ));
  for (const row of rows) {
    await pg.query(
      `INSERT INTO audit_log (entity, entity_id, action, actor_id, at, changes, reason)
       VALUES ($1, $2, 'delete', $3, now(), $4, $5)`,
      [table, Number(row.id), actorId, JSON.stringify({ __row: { before: '[DB CRUD fallback cleanup]' } }), 'DB CRUD isolated fixture cleanup'],
    );
  }
}

async function cleanupStaleFixtures(pg: PostgresConnectionService, actorId: number): Promise<void> {
  // 예약된 DBCRUD 표식만 대상으로 삼는다. 재시도/강제 종료로 남은 이전 QA 자산도
  // 다음 실행 시작 전에 soft-delete + audit 하여 production active 데이터와 분리한다.
  await fallbackSoftDelete(pg, 'class_sessions',
    `course_id IN (SELECT id FROM courses WHERE name LIKE 'DB CRUD 수업 %')`, [], actorId);
  await fallbackSoftDelete(pg, 'availability_blocks',
    `owner_type='student' AND owner_id IN (SELECT id FROM students WHERE name LIKE 'DBCRUD%')`, [], actorId);
  await fallbackSoftDelete(pg, 'calendar_view_presets', `name LIKE 'DB-CRUD-%'`, [], actorId);
  await fallbackSoftDelete(pg, 'counsel_rounds',
    `counsel_form_id IN (SELECT id FROM counsel_forms WHERE reference_notes LIKE 'DBCRUD 상담 %')`, [], actorId);
  await fallbackSoftDelete(pg, 'counsel_forms', `reference_notes LIKE 'DBCRUD 상담 %'`, [], actorId);
  await fallbackSoftDelete(pg, 'student_family_relations',
    `(student_id_a IN (SELECT id FROM students WHERE name LIKE 'DBCRUD%')
       OR student_id_b IN (SELECT id FROM students WHERE name LIKE 'DBCRUD%'))`, [], actorId);
  await fallbackSoftDelete(pg, 'student_academic_histories',
    `student_id IN (SELECT id FROM students WHERE name LIKE 'DBCRUD%')`, [], actorId);
  await fallbackSoftDelete(pg, 'student_interests',
    `student_id IN (SELECT id FROM students WHERE name LIKE 'DBCRUD%')`, [], actorId);
  await fallbackSoftDelete(pg, 'courses', `name LIKE 'DB CRUD 수업 %'`, [], actorId);
  await fallbackSoftDelete(pg, 'students', `name LIKE 'DBCRUD%'`, [], actorId);
  await fallbackSoftDelete(pg, 'rooms', `name LIKE 'DB CRUD 강의실 %'`, [], actorId);
  await fallbackSoftDelete(pg, 'subjects', `code LIKE 'dbcrud_%'`, [], actorId);
  await fallbackSoftDelete(pg, 'instructor_profiles',
    `user_id IN (SELECT id FROM users WHERE web_id LIKE 'dbcrud_inst_%')`, [], actorId, 'active=false', 'user_id');
  await fallbackSoftDelete(pg, 'users', `web_id LIKE 'dbcrud_inst_%'`, [], actorId, "status='rejected'");
}

async function cleanupFixtures(): Promise<void> {
  let cleanupApp: INestApplication | undefined;
  try {
    const booted = await boot();
    cleanupApp = booted.app;
    const { http, manager, ceo } = booted;
    if (qaCounselId) await http.delete(`/api/counsel/${qaCounselId}`).set(auth(ceo));
    for (const id of qaSessionIds) await http.delete(`/api/schedule/${id}`).set(auth(manager));
    for (const id of qaAvailabilityIds) await http.delete(`/api/availability/${id}`).set(auth(manager));
    for (const id of qaPresetIds) await http.delete(`/api/view-presets/${id}`).set(auth(manager));
    if (qaCourseId) await http.delete(`/api/courses/${qaCourseId}`).set(auth(manager));
    if (qaRoomId) await http.delete(`/api/rooms/${qaRoomId}`).set(auth(manager));
    if (qaSubjectId) await http.delete(`/api/subjects/${qaSubjectId}`).set(auth(manager));
    // [74D-1] DELETE /students/:id는 SudoGuard(원부 삭제 재인증) — Bearer만이면 403으로
    //  API 경로가 조용히 실패하고 fallbackSoftDelete가 가려준다. 정규 경로를 살린다.
    if (qaStudentId) await http.delete(`/api/students/${qaStudentId}`).set(sudoAuthHeaders(cleanupApp, manager));
    if (qaRelatedStudentId) await http.delete(`/api/students/${qaRelatedStudentId}`).set(sudoAuthHeaders(cleanupApp, manager));
    if (qaInstructorId) await http.delete(`/api/instructors/${qaInstructorId}`).set(auth(ceo));

    // API 도중 실패/프로세스 재시도에도 테스트 자산을 active 상태로 남기지 않는다.
    // 물리 DELETE는 금지하고, fallback도 audit_log를 남기는 soft-delete만 수행한다.
    const pg = cleanupApp.get(PostgresConnectionService);
    if (qaCounselId) {
      await fallbackSoftDelete(pg, 'counsel_rounds', 'counsel_form_id=$2', [qaCounselId], ceoActorId);
      await fallbackSoftDelete(pg, 'counsel_forms', 'id=$2', [qaCounselId], ceoActorId);
    }
    if (qaCourseId) {
      await fallbackSoftDelete(pg, 'class_sessions', 'course_id=$2', [qaCourseId], ceoActorId);
      await fallbackSoftDelete(pg, 'courses', 'id=$2', [qaCourseId], ceoActorId);
    }
    for (const id of qaAvailabilityIds) await fallbackSoftDelete(pg, 'availability_blocks', 'id=$2', [id], ceoActorId);
    for (const id of qaPresetIds) await fallbackSoftDelete(pg, 'calendar_view_presets', 'id=$2', [id], ceoActorId);
    if (qaStudentId) {
      await fallbackSoftDelete(pg, 'student_family_relations', '(student_id_a=$2 OR student_id_b=$2)', [qaStudentId], ceoActorId);
      await fallbackSoftDelete(pg, 'student_academic_histories', 'student_id=$2', [qaStudentId], ceoActorId);
      await fallbackSoftDelete(pg, 'student_interests', 'student_id=$2', [qaStudentId], ceoActorId);
      await fallbackSoftDelete(pg, 'students', 'id=$2', [qaStudentId], ceoActorId);
    }
    if (qaRelatedStudentId) {
      await fallbackSoftDelete(pg, 'student_family_relations', '(student_id_a=$2 OR student_id_b=$2)', [qaRelatedStudentId], ceoActorId);
      await fallbackSoftDelete(pg, 'student_academic_histories', 'student_id=$2', [qaRelatedStudentId], ceoActorId);
      await fallbackSoftDelete(pg, 'student_interests', 'student_id=$2', [qaRelatedStudentId], ceoActorId);
      await fallbackSoftDelete(pg, 'students', 'id=$2', [qaRelatedStudentId], ceoActorId);
    }
    if (qaRoomId) await fallbackSoftDelete(pg, 'rooms', 'id=$2', [qaRoomId], ceoActorId);
    if (qaSubjectId) await fallbackSoftDelete(pg, 'subjects', 'id=$2', [qaSubjectId], ceoActorId);
    if (qaInstructorId) {
      await fallbackSoftDelete(pg, 'instructor_profiles', 'user_id=$2', [qaInstructorId], ceoActorId, 'active=false', 'user_id');
      await fallbackSoftDelete(pg, 'users', 'id=$2', [qaInstructorId], ceoActorId, "status='rejected'");
    }
  } finally {
    if (cleanupApp) await closeApp(cleanupApp);
    for (const app of [...openApps]) await closeApp(app);
  }
}

describeDb('Postgres-backed backend CRUD (e2e)', () => {
  beforeAll(async () => {
    config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
      throw new Error('DATABASE_URL/POSTGRES_URL is required. Run with RUN_DB_CRUD_E2E=1 DOTENV_CONFIG_PATH=.env.local.');
    }
    // NODE_ENV=test의 E2E fixture를 운영 DB에 절대 반영하지 않는다.
    process.env.TEST_BUSINESS_FIXTURES = '0';

    const initialApp = await createTestApp();
    openApps.add(initialApp);
    const users = initialApp.get(UsersService).findAll();
    const manager = users.find((row) => row.role === 'manager' && row.status === 'active' && row.deletedAt == null);
    const ceo = users.find((row) => row.role === 'super_admin' && row.status === 'active' && row.deletedAt == null);
    if (!manager || !ceo) throw new Error('DB CRUD requires one active manager and one active super_admin; no credentials are read.');
    managerActorId = manager.id;
    ceoActorId = ceo.id;
    await cleanupStaleFixtures(initialApp.get(PostgresConnectionService), ceoActorId);
    await closeApp(initialApp);

    const app = await createTestApp();
    openApps.add(app);
    const http = request(app.getHttpServer());
    const managerToken = tokenFor(app, managerActorId);
    const ceoToken = tokenFor(app, ceoActorId);
    const stamp = `${Date.now()}_${process.pid}`;
    // [74D-1] 강사 직접 등록은 SudoGuard(대표 전용·재인증 필수) — Bearer 단독은 403 SUDO_REQUIRED.
    qaInstructorId = Number((await http.post('/api/users/instructors')
      .set(sudoAuthHeaders(app, ceoToken))
      .send({
        webId: `dbcrud_inst_${stamp}`,
        name: `DB CRUD 강사 ${stamp}`,
        password: `DbCrud!${stamp}`,
        defaultHourlyRate: 40_000,
        canTeachKinder: false,
        countryCode: 'KR',
        timeZone: 'Asia/Seoul',
      })
      .expect(201)).body.id);
    qaSubjectId = Number((await http.post('/api/subjects').set(auth(managerToken))
      .send({ code: `dbcrud_${stamp}`, name: `DB CRUD 과목 ${stamp}` }).expect(201)).body.id);
    qaRoomId = Number((await http.post('/api/rooms').set(auth(managerToken))
      .send({ name: `DB CRUD 강의실 ${stamp}`, capacity: 4, isActive: true }).expect(201)).body.id);
    qaStudentId = Number((await http.post('/api/students').set(auth(managerToken))
      .send(studentAggregateBody(`DBCRUD${String(Date.now()).slice(-8)}`, {
        interests: [
          { customLabel: 'DB CRUD 희망 수업 A', priority: 1 },
          { customLabel: 'DB CRUD 희망 수업 B', priority: 2 },
        ],
      })).expect(201)).body.student.id);
    qaRelatedStudentId = Number((await http.post('/api/students').set(auth(managerToken))
      .send(studentAggregateBody(`DBCRUD가족${String(Date.now()).slice(-8)}`, {
        interests: [
          { customLabel: 'DB CRUD 가족 희망 수업 A', priority: 1 },
          { customLabel: 'DB CRUD 가족 희망 수업 B', priority: 2 },
        ],
      })).expect(201)).body.student.id);
    qaCourseId = Number((await http.post('/api/courses').set(auth(managerToken))
      .send({
        name: `DB CRUD 수업 ${stamp}`,
        subjectId: qaSubjectId,
        instructorId: qaInstructorId,
        price: 100_000,
        isKinder: false,
      }).expect(201)).body.id);
    await closeApp(app);
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it('performs C/R/U/D on availability and persists audit rows across app restarts', async () => {
    const stamp = Date.now();
    const effectiveDate = `2099-10-${String((stamp % 20) + 1).padStart(2, '0')}`;
    let availabilityId = 0;

    {
      const { app, http, manager } = await boot();
      const created = (await http.put('/api/availability')
        .set(auth(manager))
        .send({
          ownerType: 'student',
          ownerId: qaStudentId,
          kind: 'online_only',
          weekday: 6,
          startTime: '07:00',
          endTime: '07:30',
          effectiveFrom: effectiveDate,
          effectiveTo: effectiveDate,
        })
        .expect(200)).body as AvailabilityRow;
      availabilityId = created.id;
      qaAvailabilityIds.add(availabilityId);
      expect(created).toMatchObject({ kind: 'online_only', startTime: '07:00', endTime: '07:30' });
      await closeApp(app);
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get(`/api/availability?ownerType=student&ownerId=${qaStudentId}`)
        .set(auth(manager))
        .expect(200)).body as AvailabilityRow[];
      expect(rows.find((row) => row.id === availabilityId)).toMatchObject({
        kind: 'online_only',
        startTime: '07:00',
        endTime: '07:30',
      });

      const updated = (await http.put('/api/availability')
        .set(auth(manager))
        .send({
          id: availabilityId,
          ownerType: 'student',
          ownerId: qaStudentId,
          kind: 'unavailable',
          weekday: 6,
          startTime: '07:30',
          endTime: '08:00',
          effectiveFrom: effectiveDate,
          effectiveTo: effectiveDate,
        })
        .expect(200)).body as AvailabilityRow;
      expect(updated).toMatchObject({ kind: 'unavailable', startTime: '07:30', endTime: '08:00' });
      await closeApp(app);
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get(`/api/availability?ownerType=student&ownerId=${qaStudentId}`)
        .set(auth(manager))
        .expect(200)).body as AvailabilityRow[];
      expect(rows.find((row) => row.id === availabilityId)).toMatchObject({
        kind: 'unavailable',
        startTime: '07:30',
        endTime: '08:00',
      });

      const auditBeforeDelete = (await http.get(`/api/audit?entity=availability_blocks&entityId=${availabilityId}`)
        .set(auth(manager))
        .expect(200)).body as AuditRow[];
      expect(auditBeforeDelete.some((row) => row.action === 'create' && row.changes?.__row)).toBe(true);
      expect(auditBeforeDelete.some((row) => row.action === 'update' && row.changes?.kind)).toBe(true);

      await http.delete(`/api/availability/${availabilityId}`).set(auth(manager)).expect(200);
      qaAvailabilityIds.delete(availabilityId);
      await closeApp(app);
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get(`/api/availability?ownerType=student&ownerId=${qaStudentId}`)
        .set(auth(manager))
        .expect(200)).body as AvailabilityRow[];
      expect(rows.some((row) => row.id === availabilityId)).toBe(false);

      const auditAfterDelete = (await http.get(`/api/audit?entity=availability_blocks&entityId=${availabilityId}`)
        .set(auth(manager))
        .expect(200)).body as AuditRow[];
      expect(auditAfterDelete.some((row) => row.action === 'delete' && row.changes?.__row)).toBe(true);
      await closeApp(app);
    }
  });

  it('performs C/R/U/D on calendar view presets across app restarts', async () => {
    const stamp = Date.now();
    const name = `DB-CRUD-${stamp}`;
    let presetId = 0;

    {
      const { app, http, manager } = await boot();
      const created = (await http.post('/api/view-presets')
        .set(auth(manager))
        .send({
          name,
          view: 'week',
          periodFrom: '2099-10-01',
          periodTo: '2099-10-07',
          instructorIds: [qaInstructorId],
          studentIds: [qaStudentId],
          roomIds: [qaRoomId],
          subjects: ['english'],
          statuses: [],
          groupOnly: false,
          colorBy: 'instructor',
          countryCode: 'KR',
          modeFilters: ['online'],
          kstFixed: true,
          compactCols: false,
          manualPanes: [{ uid: 1, dim: 'instructor', ids: [qaInstructorId], countryCode: 'KR' }],
        })
        .expect(201)).body as ViewPresetRow;
      presetId = created.id;
      qaPresetIds.add(presetId);
      expect(created).toMatchObject({ name, view: 'week' });
      await closeApp(app);
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/view-presets').set(auth(manager)).expect(200)).body as ViewPresetRow[];
      expect(rows.find((row) => row.id === presetId)).toMatchObject({
        name,
        view: 'week',
        instructorIds: [qaInstructorId],
      });

      const updated = (await http.patch(`/api/view-presets/${presetId}`)
        .set(auth(manager))
        .send({
          name,
          view: 'day',
          periodFrom: '2099-10-02',
          periodTo: '2099-10-02',
          instructorIds: [qaInstructorId],
          studentIds: [qaStudentId],
          roomIds: [qaRoomId],
          subjects: ['english'],
          statuses: [],
          groupOnly: false,
          colorBy: 'student',
          countryCode: 'KR',
          modeFilters: ['online'],
          kstFixed: true,
          compactCols: true,
          manualPanes: [{ uid: 1, dim: 'student', ids: [qaStudentId], countryCode: 'KR' }],
        })
        .expect(200)).body as ViewPresetRow;
      expect(updated).toMatchObject({ name, view: 'day', compactCols: true });
      await closeApp(app);
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/view-presets').set(auth(manager)).expect(200)).body as ViewPresetRow[];
      expect(rows.find((row) => row.id === presetId)).toMatchObject({
        view: 'day',
        compactCols: true,
      });
      await http.delete(`/api/view-presets/${presetId}`).set(auth(manager)).expect(200);
      qaPresetIds.delete(presetId);
      await closeApp(app);
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/view-presets').set(auth(manager)).expect(200)).body as ViewPresetRow[];
      expect(rows.some((row) => row.id === presetId)).toBe(false);
      const recreated = (await http.post('/api/view-presets')
        .set(auth(manager))
        .send({
          name,
          view: 'week',
          instructorIds: [qaInstructorId],
          studentIds: [],
          roomIds: [],
          subjects: [],
          statuses: [],
          groupOnly: false,
        })
        .expect(201)).body as ViewPresetRow;
      expect(recreated.name).toBe(name);
      qaPresetIds.add(Number(recreated.id));
      await http.delete(`/api/view-presets/${recreated.id}`).set(auth(manager)).expect(200);
      qaPresetIds.delete(Number(recreated.id));
      await closeApp(app);
    }
  });

  it('persists family, academic, counsel, and round CRUD with CEO audit across restarts', async () => {
    let familyRelationId = 0;
    let academicHistoryId = 0;
    let roundId = 0;
    const schoolName = `DB CRUD School ${Date.now()}`;

    {
      const { app, http, ceo } = await boot();
      familyRelationId = Number((await http.post(`/api/students/${qaStudentId}/family-relations`)
        .set(auth(ceo))
        .send({ relatedStudentId: qaRelatedStudentId, relationType: 'sibling' })
        .expect(201)).body.id);
      academicHistoryId = Number((await http.post(`/api/students/${qaStudentId}/academic-histories`)
        .set(auth(ceo))
        .send({ grade: 13, schoolName, startedOn: '2025-01-01', endedOn: '2025-12-31' })
        .expect(201)).body.id);
      qaCounselId = Number((await http.post('/api/counsel')
        .set(auth(ceo))
        .send({
          source: 'manual',
          studentId: qaStudentId,
          referenceNotes: `DBCRUD 상담 ${Date.now()} · 비공개 참고`,
          nextContactAt: '2099-01-10T00:00:00.000Z',
        })
        .expect(201)).body.id);
      roundId = Number((await http.post(`/api/counsel/${qaCounselId}/rounds`)
        .set(auth(ceo))
        .send({ summary: 'DB CRUD 1차', nextContactAt: '2099-01-11T00:00:00.000Z' })
        .expect(201)).body.id);
      await closeApp(app);
    }

    {
      const { app, http, ceo } = await boot();
      const student = (await http.get(`/api/students/${qaStudentId}/aggregate`).set(auth(ceo)).expect(200)).body;
      expect(student.familyRelations).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: familyRelationId, relationType: 'sibling' }),
      ]));
      expect(student.academicHistories).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: academicHistoryId, grade: 13, schoolName }),
      ]));
      const related = (await http.get(`/api/students/${qaRelatedStudentId}/aggregate`).set(auth(ceo)).expect(200)).body;
      expect(related.familyRelations.some((row: { id: number }) => row.id === familyRelationId)).toBe(true);

      const counsel = (await http.get(`/api/counsel/${qaCounselId}/aggregate`).set(auth(ceo)).expect(200)).body;
      expect(counsel.form).toMatchObject({
        id: qaCounselId,
        studentId: qaStudentId,
        nextContactAt: '2099-01-11T00:00:00.000Z',
      });
      expect(counsel.student.student.id).toBe(qaStudentId);
      expect(counsel.rounds).toEqual(expect.arrayContaining([expect.objectContaining({ id: roundId })]));

      await http.patch(`/api/students/${qaStudentId}/family-relations/${familyRelationId}`)
        .set(auth(ceo)).send({ relationType: 'other', relationLabel: '사촌' }).expect(200);
      await http.patch(`/api/students/${qaStudentId}/academic-histories/${academicHistoryId}`)
        .set(auth(ceo)).send({ grade: 12, schoolName: `${schoolName} Updated` }).expect(200);
      await http.patch(`/api/counsel/${qaCounselId}/rounds/${roundId}`)
        .set(auth(ceo)).send({
          summary: 'DB CRUD 1차 수정',
          nextContactAt: '2099-01-12T00:00:00.000Z',
        }).expect(200);
      await closeApp(app);
    }

    {
      const { app, http, ceo } = await boot();
      const counsel = (await http.get(`/api/counsel/${qaCounselId}/aggregate`).set(auth(ceo)).expect(200)).body;
      expect(counsel.form.nextContactAt).toBe('2099-01-12T00:00:00.000Z');
      expect(counsel.rounds.find((row: { id: number }) => row.id === roundId)?.summary).toBe('DB CRUD 1차 수정');

      for (const [entity, entityId] of [
        ['student_family_relations', familyRelationId],
        ['student_academic_histories', academicHistoryId],
        ['counsel_rounds', roundId],
      ] as const) {
        const auditRows = (await http.get(`/api/audit?entity=${entity}&entityId=${entityId}`)
          .set(auth(ceo)).expect(200)).body as AuditRow[];
        expect(auditRows.some((row) => row.action === 'create' && row.actorId === ceoActorId)).toBe(true);
        expect(auditRows.some((row) => row.action === 'update' && row.actorId === ceoActorId)).toBe(true);
      }

      await http.delete(`/api/counsel/${qaCounselId}/rounds/${roundId}`).set(auth(ceo)).expect(200);
      await http.delete(`/api/counsel/${qaCounselId}`).set(auth(ceo)).expect(200);
      qaCounselId = 0;
      await http.delete(`/api/students/${qaStudentId}/academic-histories/${academicHistoryId}`).set(auth(ceo)).expect(200);
      await http.delete(`/api/students/${qaStudentId}/family-relations/${familyRelationId}`).set(auth(ceo)).expect(200);

      const familyAudit = (await http.get(`/api/audit?entity=student_family_relations&entityId=${familyRelationId}`)
        .set(auth(ceo)).expect(200)).body as AuditRow[];
      const academicAudit = (await http.get(`/api/audit?entity=student_academic_histories&entityId=${academicHistoryId}`)
        .set(auth(ceo)).expect(200)).body as AuditRow[];
      expect(familyAudit.some((row) => row.action === 'delete' && row.actorId === ceoActorId)).toBe(true);
      expect(academicAudit.some((row) => row.action === 'delete' && row.actorId === ceoActorId)).toBe(true);
      await closeApp(app);
    }
  });

  it('refreshes the warm calendar read model from Postgres on every read', async () => {
    const { app, http, manager } = await boot();
    const pg = app.get(PostgresConnectionService).getDataSource();
    const stamp = Date.now();
    const originalTopic = `DB-REFRESH-${stamp}`;
    const updatedTopic = `${originalTopic}-UPDATED`;
    let sessionId = 0;

    try {
      const created = (await http.post('/api/schedule').set(auth(manager)).send({
        courseId: qaCourseId,
        instructorId: qaInstructorId,
        roomId: qaRoomId,
        sessionDate: '2099-12-29',
        startTime: '08:00',
        endTime: '09:00',
        mode: 'online',
        topic: originalTopic,
      }).expect(201)).body.row as ScheduleRow;
      sessionId = Number(created.id);
      qaSessionIds.add(sessionId);

      const first = (await http.get('/api/schedule?from=2099-12-29&to=2099-12-29')
        .set(auth(manager))
        .expect(200)).body as ScheduleRow[];
      expect(first.find((row) => row.id === sessionId)?.topic).toBe(originalTopic);

      await pg.query('UPDATE class_sessions SET topic = $1, updated_at = now() WHERE id = $2', [updatedTopic, sessionId]);
      await pg.query(
        `INSERT INTO audit_log (entity, entity_id, action, actor_id, at, changes, reason)
         VALUES ('class_sessions', $1, 'update', $2, now(), $3, 'DB CRUD external-writer refresh verification')`,
        [sessionId, managerActorId, JSON.stringify({ topic: { before: originalTopic, after: updatedTopic } })],
      );
      const updated = (await http.get('/api/schedule?from=2099-12-29&to=2099-12-29')
        .set(auth(manager))
        .expect(200)).body as ScheduleRow[];
      expect(updated.find((row) => row.id === sessionId)?.topic).toBe(updatedTopic);

      await http.delete(`/api/schedule/${sessionId}`).set(auth(manager)).expect(200);
      qaSessionIds.delete(sessionId);
      const removed = (await http.get('/api/schedule?from=2099-12-29&to=2099-12-29')
        .set(auth(manager))
        .expect(200)).body as ScheduleRow[];
      expect(removed.some((row) => row.id === sessionId)).toBe(false);
    } finally {
      await closeApp(app);
    }
  });
});
