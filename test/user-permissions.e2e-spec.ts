import type { INestApplication } from '@nestjs/common';
import type { UserPermissionsProjection } from '@kms545487/contracts';
import request from 'supertest';
import { AUDIT_LOG_SPEC } from '../src/database/calendar-asset-specs';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { createTestApp, sudoAuthHeaders } from './setup-app';

jest.retryTimes(0);

describe('User capability overrides (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ceo = '';
  let admin = '';
  let manager = '';
  let instructor = '';
  let adminId = 0;
  let managerId = 0;
  let instructorId = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (webId: string, password = 'demo1234') =>
    (await http.post('/api/auth/login').send({ webId, password }).expect(201)).body.accessToken as string;
  const projection = async (targetId: number, token = ceo) =>
    (await http.get(`/api/users/${targetId}/permissions`).set(auth(token)).expect(200)).body as UserPermissionsProjection;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ceo = await login('admin');
    manager = await login('manager');
    instructor = await login('park_inst');
    const created = (await http.post('/api/users/instructors').set(sudoAuthHeaders(app, ceo)).send({
      webId: 'permission_admin',
      name: '권한 관리자',
      password: 'password123',
      role: 'admin',
      email: 'permission-admin@t82.test',
    }).expect(201)).body;
    adminId = created.id;
    admin = await login('permission_admin', 'password123');
    const db = app.get(InMemoryDatabase);
    managerId = db.findBy<{ id: number; webId: string }>('users', (row) => row.webId === 'manager')[0].id;
    instructorId = db.findBy<{ id: number; webId: string }>('users', (row) => row.webId === 'park_inst')[0].id;
  });

  afterAll(async () => app.close());

  it('대표와 관리자는 projection을 읽고 manager는 권한 관리에 접근하지 못한다', async () => {
    const ceoView = await projection(managerId);
    expect(ceoView.permissions.find((row) => row.capability === 'calendar.manage')).toMatchObject({
      roleDefault: true,
      override: null,
      effective: true,
      manageable: true,
    });
    await projection(managerId, admin);
    await http.get(`/api/users/${managerId}/permissions`).set(auth(manager)).expect(403);
  });

  it('대표 전용 출결과 구조 권한은 토글할 수 없고 admin 자기 변경도 거부한다', async () => {
    const target = await projection(managerId, admin);
    const attendance = target.permissions.find((row) => row.capability === 'attendance.manage');
    expect(attendance).toMatchObject({ effective: false, manageable: false });
    await http.put(`/api/users/${managerId}/permissions/attendance.manage`)
      .set(sudoAuthHeaders(app, admin))
      .send({ mode: 'allow', reason: '출결 권한 부여 시도 차단', expectedAccessVersion: target.accessVersion })
      .expect(400);
    const self = await projection(adminId, admin);
    await http.put(`/api/users/${adminId}/permissions/calendar.manage`)
      .set(sudoAuthHeaders(app, admin))
      .send({ mode: 'deny', reason: '자기 권한 변경 시도 차단', expectedAccessVersion: self.accessVersion })
      .expect(403);
  });

  it('관리자가 manager의 캘린더 권한을 제한·복원하면 세션과 API가 즉시 수렴한다', async () => {
    const before = await projection(managerId, admin);
    const denied = (await http.put(`/api/users/${managerId}/permissions/calendar.manage`)
      .set(sudoAuthHeaders(app, admin))
      .send({ mode: 'deny', reason: '캘린더 담당 업무 일시 회수', expectedAccessVersion: before.accessVersion })
      .expect(200)).body as UserPermissionsProjection;
    expect(denied.accessVersion).toBe(before.accessVersion + 1);
    expect(denied.permissions.find((row) => row.capability === 'calendar.manage')).toMatchObject({
      override: 'deny',
      effective: false,
    });
    await http.get('/api/auth/me').set(auth(manager)).expect(401);
    manager = await login('manager');
    await http.get('/api/schedule/instructor-attendance-summary?from=2026-01-01&to=2026-12-31')
      .set(auth(manager)).expect(403);

    const restored = (await http.put(`/api/users/${managerId}/permissions/calendar.manage`)
      .set(sudoAuthHeaders(app, admin))
      .send({ mode: 'default', reason: '캘린더 담당 업무 복원', expectedAccessVersion: denied.accessVersion })
      .expect(200)).body as UserPermissionsProjection;
    expect(restored.permissions.find((row) => row.capability === 'calendar.manage')).toMatchObject({
      override: null,
      effective: true,
    });
    await http.get('/api/auth/me').set(auth(manager)).expect(401);
    manager = await login('manager');
    await http.get('/api/schedule/instructor-attendance-summary?from=2026-01-01&to=2026-12-31')
      .set(auth(manager)).expect(200);
  });

  it('관리 업무 광역 권한은 기존 관리 역할에서만 제한·복원되고 직접 URL도 수렴한다', async () => {
    const before = await projection(managerId, admin);
    const denied = (await http.put(`/api/users/${managerId}/permissions/admin.area`)
      .set(sudoAuthHeaders(app, admin))
      .send({ mode: 'deny', reason: '관리 원부 접근 일시 제한', expectedAccessVersion: before.accessVersion })
      .expect(200)).body as UserPermissionsProjection;
    await http.get('/api/auth/me').set(auth(manager)).expect(401);
    manager = await login('manager');
    await http.get('/api/users').set(auth(manager)).expect(403);

    const restored = (await http.put(`/api/users/${managerId}/permissions/admin.area`)
      .set(sudoAuthHeaders(app, admin))
      .send({ mode: 'default', reason: '관리 원부 접근 기본값 복원', expectedAccessVersion: denied.accessVersion })
      .expect(200)).body as UserPermissionsProjection;
    expect(restored.permissions.find((row) => row.capability === 'admin.area')).toMatchObject({
      override: null,
      effective: true,
    });
    manager = await login('manager');
    await http.get('/api/users').set(auth(manager)).expect(200);

    const instructorProjection = await projection(instructorId);
    expect(instructorProjection.permissions.find((row) => row.capability === 'admin.area')?.manageable).toBe(false);
    await http.put(`/api/users/${instructorId}/permissions/admin.area`)
      .set(sudoAuthHeaders(app, ceo))
      .send({ mode: 'allow', reason: '광역 관리자 권한 승격 차단', expectedAccessVersion: instructorProjection.accessVersion })
      .expect(400);
  });

  it('대표 grant/default가 instructor 권한과 재로그인 세션에 반영된다', async () => {
    const before = await projection(instructorId);
    const granted = (await http.put(`/api/users/${instructorId}/permissions/calendar.manage`)
      .set(sudoAuthHeaders(app, ceo))
      .send({ mode: 'allow', reason: '캘린더 보조 담당 권한 부여', expectedAccessVersion: before.accessVersion })
      .expect(200)).body as UserPermissionsProjection;
    await http.get('/api/auth/me').set(auth(instructor)).expect(401);
    instructor = await login('park_inst');
    const me = (await http.get('/api/auth/me').set(auth(instructor)).expect(200)).body;
    expect(me.effectiveCapabilities).toContain('calendar.manage');

    await http.put(`/api/users/${instructorId}/permissions/calendar.manage`)
      .set(sudoAuthHeaders(app, ceo))
      .send({ mode: 'default', reason: '캘린더 보조 담당 권한 회수', expectedAccessVersion: granted.accessVersion })
      .expect(200);
    await http.get('/api/auth/me').set(auth(instructor)).expect(401);
  });

  it('같은 accessVersion의 동시 변경은 하나만 성공하고 audit을 남긴다', async () => {
    const before = await projection(managerId);
    const responses = await Promise.all([
      http.put(`/api/users/${managerId}/permissions/approval.manage`)
        .set(sudoAuthHeaders(app, ceo))
        .send({ mode: 'deny', reason: '동시 승인 권한 변경 A', expectedAccessVersion: before.accessVersion }),
      http.put(`/api/users/${managerId}/permissions/counsel.manage`)
        .set(sudoAuthHeaders(app, ceo))
        .send({ mode: 'deny', reason: '동시 상담 권한 변경 B', expectedAccessVersion: before.accessVersion }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const rows = (await http.get('/api/audit?entity=user_capability_overrides').set(auth(ceo)).expect(200)).body;
    expect(rows.some((row: { action: string; reason?: string }) =>
      row.action === 'create' && row.reason?.startsWith('동시'))).toBe(true);
  });

  it('audit 저장 실패 시 override와 authVersion을 함께 롤백한다', async () => {
    const before = await projection(instructorId);
    const store = app.get(PostgresCollectionStore);
    const original = store.insert.bind(store);
    const spy = jest.spyOn(store, 'insert').mockImplementation(async (spec, values) => {
      if (spec.table === AUDIT_LOG_SPEC.table) throw new Error('injected permission audit failure');
      return original(spec, values);
    });

    await http.put(`/api/users/${instructorId}/permissions/calendar.manage`)
      .set(sudoAuthHeaders(app, ceo))
      .send({ mode: 'allow', reason: '권한 감사 실패 원자성 검증', expectedAccessVersion: before.accessVersion })
      .expect(500);
    spy.mockRestore();

    const after = await projection(instructorId);
    expect(after.accessVersion).toBe(before.accessVersion);
    expect(after.permissions.find((row) => row.capability === 'calendar.manage')).toEqual(
      before.permissions.find((row) => row.capability === 'calendar.manage'),
    );
  });
});
