// [TBO-86I-2] 리포트 작성 표면 공통 capability(report.write) — 작성 command 4종이 같은 판정을
//  쓰고, TBO-82 사용자별 deny override가 강사의 작성 command만 403으로 닫는지(읽기는 불변) 검증.
//  소유권(본인 세션/보고서)은 계속 서비스 검증 — 이 스펙은 capability 게이트 층만 다룬다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('[TBO-86I-2] report.write capability 게이트', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let ceo: string;
  let instructor: string;
  let instructorUserId = 0;

  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken as string;
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const projection = async (targetId: number) =>
    (await http.get(`/api/users/${targetId}/permissions`).set(auth(ceo)).expect(200)).body as {
      accessVersion: number;
      permissions: Array<{ capability: string; roleDefault: boolean; effective: boolean; configurable: boolean }>;
    };

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    ceo = await login('admin');
    instructor = await login('park_inst');
    instructorUserId = db.findBy<{ id: number; webId: string }>('users', (row) => row.webId === 'park_inst')[0].id;
  });
  afterAll(async () => { await app.close(); });

  it('기본값 — 강사 report.write는 role 기본 허용이고 catalog에 configurable로 노출된다', async () => {
    const view = await projection(instructorUserId);
    expect(view.permissions.find((row) => row.capability === 'report.write')).toMatchObject({
      roleDefault: true,
      effective: true,
      configurable: true,
    });
  });

  it('deny override → 작성 command 4종 403(fail-closed), 읽기(worklist)는 그대로 — 복원 후 다시 열림', async () => {
    // 기본 상태: 작성 게이트는 통과한다(본문 검증 400 = capability 403이 아님을 구분).
    await http.post('/api/reports').set(auth(instructor)).send({}).expect(400);

    const view = await projection(instructorUserId);
    await http.put(`/api/users/${instructorUserId}/permissions/report.write`).set(sudoAuthHeaders(app, ceo))
      .send({ mode: 'deny', reason: '86I-2 게이트 검증', expectedAccessVersion: view.accessVersion })
      .expect(200);
    // override는 accessVersion을 올려 기존 토큰을 즉시 무효화한다 — 재로그인 후 판정.
    await http.get('/api/auth/me').set(auth(instructor)).expect(401);
    instructor = await login('park_inst');

    await http.post('/api/reports').set(auth(instructor)).send({}).expect(403);
    await http.patch('/api/reports/1').set(auth(instructor)).send({}).expect(403);
    await http.delete('/api/reports/1').set(auth(instructor)).expect(403);
    await http.post('/api/reports/1/submit').set(auth(instructor)).expect(403);
    // 읽기 표면은 @Roles(STAFF) 유지 — deny가 조회를 막지 않는다.
    await http.get('/api/reports/worklist').set(auth(instructor)).expect(200);

    const denied = await projection(instructorUserId);
    await http.put(`/api/users/${instructorUserId}/permissions/report.write`).set(sudoAuthHeaders(app, ceo))
      .send({ mode: 'default', reason: '86I-2 게이트 복원', expectedAccessVersion: denied.accessVersion })
      .expect(200);
    instructor = await login('park_inst');
    await http.post('/api/reports').set(auth(instructor)).send({}).expect(400); // 게이트 재개방(400=검증층 도달)
  });
});
