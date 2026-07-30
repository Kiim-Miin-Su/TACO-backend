import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 출결(attendance) 모듈 e2e — 시드·upsert·FK 무결성·권한.
describe('Attendance API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });
  let TOKEN = '';
  let FOREIGN_INSTRUCTOR = '';
  const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    TOKEN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    FOREIGN_INSTRUCTOR = (await http.post('/api/auth/login').send({ webId: 'jung_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('GET /attendance — 시드 3건, FK 필드 정합', async () => {
    const rows = (await http.get('/api/attendance').set(auth()).expect(200)).body;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((a: { sessionId: number; studentId: number; status: string }) =>
      a.sessionId > 0 && a.studentId > 0 && ['present', 'late', 'absent', 'excused'].includes(a.status))).toBe(true);
  });

  it('GET /attendance?sessionId=1 — 세션 필터(시드 2건)', async () => {
    const rows = (await http.get('/api/attendance?sessionId=1').set(auth()).expect(200)).body;
    expect(rows.length).toBe(2);
    expect(rows.every((a: { sessionId: number }) => a.sessionId === 1)).toBe(true);
  });

  it('PUT /attendance — 기존 (세션1,학생1) 갱신: 신규 행 없이 status만 변경', async () => {
    const before = (await http.get('/api/attendance').set(auth()).expect(200)).body.length;
    const row = (await http.put('/api/attendance').set(auth())
      .send({ sessionId: 1, studentId: 1, status: 'absent' }).expect(200)).body;
    expect(row.status).toBe('absent');
    expect(row.id).toBe(1); // 동일 행 갱신
    const after = (await http.get('/api/attendance').set(auth()).expect(200)).body.length;
    expect(after).toBe(before); // 이중 기록 없음
  });

  it('PUT /attendance — 세션 코호트 밖 학생은 거부', async () => {
    const before = (await http.get('/api/attendance').set(auth()).expect(200)).body.length;
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: 2, studentId: 2, status: 'present' }).expect(400);
    const after = (await http.get('/api/attendance').set(auth()).expect(200)).body.length;
    expect(after).toBe(before);
  });

  it('PUT /attendance — 없는 세션 → 400 (FK 무결성)', async () => {
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: 99999, studentId: 1, status: 'present' }).expect(400);
  });

  it('PUT /attendance — 없는 학생 → 400 (FK 무결성)', async () => {
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: 1, studentId: 99999, status: 'present' }).expect(400);
  });

  it('PUT /attendance — 잘못된 status → 400', async () => {
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: 1, studentId: 1, status: 'unknown' }).expect(400);
  });

  it('권한: 비로그인 접근 401', async () => {
    await http.get('/api/attendance').expect(401);
    await http.put('/api/attendance').send({ sessionId: 1, studentId: 1, status: 'present' }).expect(401);
    await http.delete('/api/attendance/1/1').send({ reason: '비로그인 초기화' }).expect(401);
  });

  it('DELETE /attendance/:sessionId/:studentId — 미선택 복귀·상태 자동전이·권한·감사 이력', async () => {
    await http.patch('/api/schedule/1').set(auth())
      .send({ instructorAttendance: 'present' }).expect(200);
    expect((await http.get('/api/schedule/1').set(auth()).expect(200)).body.status).toBe('held');

    await http.delete('/api/attendance/1/1').set(auth()).send({}).expect(400);
    await http.delete('/api/attendance/1/1')
      .set({ Authorization: `Bearer ${FOREIGN_INSTRUCTOR}` })
      .send({ reason: '타 강사 출결 초기화 시도' }).expect(403);

    // [TBO-79 B4] held → scheduled 역전이는 정산 예상액을 바꾸므로 회계 확인이 선행된다.
    //  첫 요청은 영향 미리보기와 함께 409 — 이 시점에 아무것도 바뀌지 않아야 한다.
    const blocked = await http.delete('/api/attendance/1/1').set(auth())
      .send({ reason: '학생 출결 오입력 정정' }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(blocked.body.impactHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await http.get('/api/schedule/1').set(auth()).expect(200)).body.status).toBe('held');
    expect(((await http.get('/api/attendance?sessionId=1').set(auth()).expect(200)).body as Array<{ studentId: number }>)
      .some((row) => row.studentId === 1)).toBe(true);

    // 맹목 ack 금지 — hash 미회신은 다시 409(schedule과 동일 규약).
    await http.delete('/api/attendance/1/1').set(auth())
      .send({ reason: '학생 출결 오입력 정정', acknowledgeAccountingImpact: true }).expect(409);

    const cleared = (await http.delete('/api/attendance/1/1').set(auth())
      .send({
        reason: '학생 출결 오입력 정정',
        acknowledgeAccountingImpact: true,
        expectedAccountingImpactHash: blocked.body.impactHash,
      }).expect(200)).body;
    expect(cleared).toMatchObject({ id: 1, sessionId: 1, studentId: 1, deleted: true });
    const after = (await http.get('/api/attendance?sessionId=1').set(auth()).expect(200)).body;
    expect(after.some((row: { studentId: number }) => row.studentId === 1)).toBe(false);
    expect((await http.get('/api/schedule/1').set(auth()).expect(200)).body.status).toBe('scheduled');

    const logs = (await http.get('/api/audit?entity=attendance').set(asAdmin()).expect(200)).body;
    expect(logs.some((row: { entityId: number; action: string; reason?: string }) =>
      row.entityId === 1 && row.action === 'delete' && row.reason === '학생 출결 오입력 정정')).toBe(true);
    // [TBO-79 B6] 확인 지문이 세션 audit에 영속 — "무엇을 보고 초기화했는가"가 재구성된다.
    const sessionLogs = (await http.get('/api/audit?entity=class_sessions&entityId=1').set(asAdmin()).expect(200))
      .body as Array<{ action: string; changes?: Record<string, { after?: { hash?: string } }> }>;
    expect(sessionLogs.some((row) => row.action === 'update'
      && row.changes?.accountingImpactAcknowledgement?.after?.hash === blocked.body.impactHash)).toBe(true);

    await http.delete('/api/attendance/1/1').set(auth())
      .send({ reason: '이미 초기화된 출결 재시도' }).expect(404);

    await http.put('/api/attendance').set(auth())
      .send({ sessionId: 1, studentId: 1, status: 'present' }).expect(200);
  });

  // [출결 이력 2026-07-07] 학생 출결 변경이 audit_log에 기록되는지(스케줄 audit과 대칭)
  it('PUT /attendance — 변경이 audit_log에 기록(entity=attendance, action=update/create)', async () => {
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: 1, studentId: 4, status: 'excused' }).expect(200); // 기존 갱신
    const logs = (await http.get('/api/audit?entity=attendance').set(asAdmin()).expect(200)).body;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l: { entity: string }) => l.entity === 'attendance')).toBe(true);
    const latest = logs[0];
    expect(['update', 'create']).toContain(latest.action);
    expect(latest.actorId).toBeGreaterThan(0); // JWT sub 기록
  });
});
