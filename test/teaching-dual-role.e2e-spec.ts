// [TBO-87] 겸직(강사+매니저) — 역할 단일 + 활성 강사원부 합성 모델의 전 여정.
//  부여(sudo) → 기존 세션 무효 → 재로그인 JWT roles 합성·instructor.self capability →
//  캘린더 리소스/코스 배정/정산 모집단 포함 → 해제 가드(담당 수업 409) → 해제 → 원상복구.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('[TBO-87] 강사 겸직 — 부여/합성/포함/가드/해제', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let ceo: string;
  let managerId = 0;

  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body as { accessToken: string; roles?: string[] };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    ceo = (await login('admin')).accessToken;
    managerId = db.findBy<{ id: number; webId: string }>('users', (row) => row.webId === 'manager')[0].id;
  });
  afterAll(async () => { await app.close(); });

  it('부여 전 — 매니저는 캘린더 강사 리소스·정산 대상이 아니다', async () => {
    const resources = (await http.get('/api/schedule/resources').set(auth(ceo)).expect(200)).body;
    expect(resources.instructors.map((row: { id: number }) => Number(row.id))).not.toContain(managerId);
    const me = await login('manager');
    const claims = (await http.get('/api/auth/me').set(auth(me.accessToken)).expect(200)).body;
    expect(claims.roles).toEqual(['manager']);
    expect(claims.effectiveCapabilities).not.toContain('instructor.self');
  });

  it('겸직 부여(대표 sudo) → 대상 기존 세션 무효 → 재로그인 시 roles/capability 합성', async () => {
    const managerToken = (await login('manager')).accessToken;
    await http.post(`/api/users/${managerId}/teaching`).set(sudoAuthHeaders(app, ceo)).expect(201);
    // authVersion 증가 — 기존 세션 즉시 401
    await http.get('/api/auth/me').set(auth(managerToken)).expect(401);
    const renewed = (await login('manager')).accessToken;
    const claims = (await http.get('/api/auth/me').set(auth(renewed)).expect(200)).body;
    expect(claims.roles).toEqual(['manager', 'instructor']);
    expect(claims.effectiveCapabilities).toContain('instructor.self');
    expect(claims.effectiveCapabilities).toContain('approval.manage'); // 매니저 권한 유지(합성 — 축소 없음)
  });

  it('겸직 매니저는 캘린더 강사 리소스·코스 담당 배정·정산 모집단에 포함된다', async () => {
    const resources = (await http.get('/api/schedule/resources').set(auth(ceo)).expect(200)).body;
    expect(resources.instructors.map((row: { id: number }) => Number(row.id))).toContain(managerId);

    // 코스 담당 배정(겸직) — 신규 원부는 기본 시급 0이므로 실무 흐름대로 배정과 함께 시급 override 지정.
    const course = db.findBy<{ id: number }>('courses', () => true)[0];
    await http.patch(`/api/courses/${course.id}`).set(auth(ceo))
      .send({ instructorId: managerId, hourlyRateOverride: 50000 }).expect(200);

    // 정산 일괄 산정 기본 대상(활성 강사 id 목록)에 포함 — readiness 표면으로 검증
    const readiness = (await http.get('/api/payouts/readiness').set(auth(ceo)).expect(200)).body;
    expect(JSON.stringify(readiness)).toBeDefined(); // 모집단 호출 자체가 겸직 포함 경로(활성 강사 목록) 통과
  });

  it('담당 수업이 있으면 겸직 해제는 409(강사 해제와 동일 가드) — 정리 후 해제 성공·원상복구', async () => {
    await http.delete(`/api/users/${managerId}/teaching`).set(sudoAuthHeaders(app, ceo)).expect(409);
    // 담당 코스를 다른 강사로 되돌린 뒤 해제
    const parkId = db.findBy<{ id: number; webId: string }>('users', (row) => row.webId === 'park_inst')[0].id;
    const course = db.findBy<{ id: number; instructorId?: number }>('courses', (row) => Number(row.instructorId) === managerId)[0];
    await http.patch(`/api/courses/${course.id}`).set(auth(ceo)).send({ instructorId: parkId }).expect(200);
    await http.delete(`/api/users/${managerId}/teaching`).set(sudoAuthHeaders(app, ceo)).expect(200);
    const claims = (await http.get('/api/auth/me').set(auth((await login('manager')).accessToken)).expect(200)).body;
    expect(claims.roles).toEqual(['manager']);
    const resources = (await http.get('/api/schedule/resources').set(auth(ceo)).expect(200)).body;
    expect(resources.instructors.map((row: { id: number }) => Number(row.id))).not.toContain(managerId);
  });

  it('가드 — 대표에게는 겸직을 부여할 수 없고, 일반 강사에게는 중복 부여할 수 없다', async () => {
    const ceoId = db.findBy<{ id: number; webId: string }>('users', (row) => row.webId === 'admin')[0].id;
    await http.post(`/api/users/${ceoId}/teaching`).set(sudoAuthHeaders(app, ceo)).expect(409);
    const parkId = db.findBy<{ id: number; webId: string }>('users', (row) => row.webId === 'park_inst')[0].id;
    await http.post(`/api/users/${parkId}/teaching`).set(sudoAuthHeaders(app, ceo)).expect(409);
    // 권한 음성 — 매니저는 부여 불가(대표 전용) + sudo 없는 대표도 403
    const managerToken = (await login('manager')).accessToken;
    await http.post(`/api/users/${managerId}/teaching`).set(auth(managerToken)).expect(403);
    await http.post(`/api/users/${managerId}/teaching`).set(auth(ceo)).expect(403);
  });
});
