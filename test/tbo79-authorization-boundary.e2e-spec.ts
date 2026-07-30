// [TBO-79 C1·C2 2026-07-30] 권한 경계 회귀.
//
//  C1: /instructors 변경 명령에 SudoGuard가 없었다. /users의 쌍둥이 라우트는 전부 sudo를 요구하고,
//      POST /instructors는 sudo가 걸린 POST /users/instructors와 **같은** provisionInstructor를 호출한다.
//      sudo.guard.ts 주석이 "강사 직접 등록"을 보호 대상으로 명시하고 있어 의도된 예외가 아니었다.
//      → 세션 탈취만으로 로그인 가능한 계정 생성·직원 계정 삭제가 가능했다.
//  C2: ApproveReportDto.approvedBy가 클라이언트 지정 actor 채널이었다. DTO에 선언돼 있으므로
//      forbidNonWhitelisted를 통과하고, 그 값이 audit_log.actorId가 된다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders, mondayISO, addDaysISO } from './setup-app';

jest.setTimeout(20000);

describe('[TBO-79] 권한 경계 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const sudo = (who: string) => sudoAuthHeaders(app, tokens[who]);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  // ── C1 ──────────────────────────────────────────────────────────────────
  it('C1 — /instructors 변경 3종은 sudo 쿠키 없이는 403 SUDO_REQUIRED', async () => {
    const webId = `tbo79_${Date.now().toString(36)}`;
    const create = await http.post('/api/instructors').set(bearer('admin'))
      .send({ webId, name: 'sudo 없이 생성', password: 'password123' }).expect(403);
    expect(create.body.code ?? create.body.message).toMatch(/SUDO_REQUIRED/);

    const patch = await http.patch('/api/instructors/1').set(bearer('admin'))
      .send({ defaultHourlyRate: 99000 }).expect(403);
    expect(patch.body.code ?? patch.body.message).toMatch(/SUDO_REQUIRED/);

    const remove = await http.delete('/api/instructors/1').set(bearer('admin')).expect(403);
    expect(remove.body.code ?? remove.body.message).toMatch(/SUDO_REQUIRED/);

    // 거부된 요청은 아무것도 바꾸지 않는다.
    expect((await http.get('/api/instructors/1').set(bearer('admin')).expect(200)).body.defaultHourlyRate).toBe(50000);
    const list = (await http.get('/api/instructors').set(bearer('admin')).expect(200)).body as Array<{ webId: string }>;
    expect(list.some((row) => row.webId === webId)).toBe(false);
  });

  it('C1 — 읽기는 sudo 없이 통과하고, sudo가 있으면 변경도 통과한다', async () => {
    await http.get('/api/instructors').set(bearer('admin')).expect(200);
    await http.patch('/api/instructors/1').set(sudo('admin')).send({ defaultHourlyRate: 51000 }).expect(200);
    expect((await http.get('/api/instructors/1').set(bearer('admin')).expect(200)).body.defaultHourlyRate).toBe(51000);
    await http.patch('/api/instructors/1').set(sudo('admin')).send({ defaultHourlyRate: 50000 }).expect(200);
  });

  // ── C2 ──────────────────────────────────────────────────────────────────
  it('C2 — 보고서 승인 body는 actor를 받지 않는다(위조 필드는 400, audit actor는 토큰)', async () => {
    const PAST = addDaysISO(mondayISO(), -35);
    const session = (await http.post('/api/schedule').set(sudo('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: PAST, startTime: '16:00', durationMinutes: 60, force: true })
      .expect(201)).body.row;
    const report = (await http.post('/api/reports').set(bearer('park_inst'))
      .send({ sessionId: session.id, studentId: 1, content: 'TBO-79 actor 권위 회귀' }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/submit`).set(bearer('park_inst')).send({}).expect(201);

    // approvedBy를 실으면 whitelist가 거부한다(종전엔 통과 후 audit actor가 됐다).
    await http.post(`/api/reports/${report.id}/approve`).set(bearer('admin')).send({ approvedBy: 1 }).expect(400);
    expect((await http.get(`/api/reports/${report.id}`).set(bearer('admin')).expect(200)).body.approvalStatus).toBe('submitted');

    const approved = (await http.post(`/api/reports/${report.id}/approve`).set(bearer('admin')).send({}).expect(201)).body;
    const adminId = (await http.get('/api/auth/me').set(bearer('admin')).expect(200)).body.sub;
    expect(approved.approvedBy).toBe(adminId);

    const audit = (await http.get(`/api/audit?entity=session_reports&entityId=${report.id}`).set(sudo('admin')).expect(200))
      .body as Array<{ action: string; actorId: number }>;
    const approveAudit = audit.filter((row) => row.action === 'approve');
    expect(approveAudit.length).toBeGreaterThan(0);
    for (const row of approveAudit) expect(row.actorId).toBe(adminId);
  });
});
