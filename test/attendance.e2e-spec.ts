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
  const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    TOKEN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
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

  it('PUT /attendance — 신규 (세션2,학생1) 삽입', async () => {
    const before = (await http.get('/api/attendance').set(auth()).expect(200)).body.length;
    const row = (await http.put('/api/attendance').set(auth())
      .send({ sessionId: 2, studentId: 1, status: 'present' }).expect(200)).body;
    expect(row.id).toBeGreaterThan(3);
    const after = (await http.get('/api/attendance').set(auth()).expect(200)).body.length;
    expect(after).toBe(before + 1);
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
