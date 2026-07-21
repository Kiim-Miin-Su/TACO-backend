// [B7 E3 2026-07-16] 상세 단건 GET — schedule/counsel 신설 + reports 스코프 갭(IDOR) 수정 검증.
//  단건 GET 표준(B7 문서 §1b): 없는 id=404 → 존재하나 스코프 밖=403. 무토큰=401.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('Detail single-fetch endpoints (e2e, B7 E3)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let inst = '';
  let instId = 0; // 강사 식별자 = users.id 자체(2026-07-07 통일 — 별도 instructorId 브리지 없음)
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    const user = db.findAll<{ id: number; webId: string }>('users').find((u) => u.webId === 'park_inst');
    instId = Number(user?.id ?? 0);
    expect(instId).toBeGreaterThan(0);
  });
  afterAll(async () => { await app.close(); });

  it('GET /schedule/:id — enriched 단건(목록과 동일 형상), 없는 id 404, 무토큰 401', async () => {
    const created = (await http.post('/api/schedule').set(auth(admin)).send({
      courseId: 10, instructorId: instId, sessionDate: '2026-06-20', startTime: '05:00', durationMinutes: 60, force: true,
    }).expect(201)).body.row;
    const row = (await http.get(`/api/schedule/${created.id}`).set(auth(admin)).expect(200)).body;
    expect(row.id).toBe(created.id);
    expect(row.courseName).toBeTruthy(); // enrich 형상(ScheduleRow) — raw 행이 아님
    expect(row.instructorName).toBeTruthy();
    await http.get('/api/schedule/999999').set(auth(admin)).expect(404);
    await http.get(`/api/schedule/${created.id}`).expect(401);
  });

  it('GET /schedule/:id — 강사는 본인 세션 200, 타 강사 세션 403(404→403 표준)', async () => {
    const mine = (await http.post('/api/schedule').set(auth(admin)).send({
      courseId: 10, instructorId: instId, sessionDate: '2026-06-21', startTime: '05:00', durationMinutes: 60, force: true,
    }).expect(201)).body.row;
    const resources = (await http.get('/api/schedule/resources').set(auth(admin)).expect(200)).body;
    const otherInstructor = resources.instructors.find((i: { id: number }) => Number(i.id) !== instId);
    expect(otherInstructor).toBeTruthy();
    const others = (await http.post('/api/schedule').set(auth(admin)).send({
      courseId: 10, instructorId: Number(otherInstructor.id), sessionDate: '2026-06-22', startTime: '05:00', durationMinutes: 60, force: true,
    }).expect(201)).body.row;
    expect((await http.get(`/api/schedule/${mine.id}`).set(auth(inst)).expect(200)).body.instructorId).toBe(instId);
    await http.get(`/api/schedule/${others.id}`).set(auth(inst)).expect(403);
    await http.get('/api/schedule/999999').set(auth(inst)).expect(404); // 없는 id는 강사에게도 404(403 아님)
  });

  it('GET /counsel/:id — 단건 200 · 없는 id 404 · 무토큰 401', async () => {
    const form = (await http.post('/api/counsel').set(auth(admin)).send({
      applicantName: 'B7 단건화 검증', applicantPhone: '010-1234-5678', source: 'manual',
    }).expect(201)).body;
    const got = (await http.get(`/api/counsel/${form.id}`).set(auth(admin)).expect(200)).body;
    expect(got.id).toBe(form.id);
    expect(got.applicantName).toBe('B7 단건화 검증');
    await http.get('/api/counsel/999999').set(auth(admin)).expect(404);
    await http.get(`/api/counsel/${form.id}`).expect(401);
  });

  it('GET /reports/:id — [스코프 갭 수정] 강사는 본인 보고서만: 본인 200 · 타인 403 · 관리자 200', async () => {
    const reports = db.findAll<{ id: number; instructorId: number }>('session_reports');
    const own = reports.find((r) => r.instructorId === instId);
    const foreign = reports.find((r) => r.instructorId !== instId);
    expect(own).toBeTruthy();
    expect(foreign).toBeTruthy();
    expect((await http.get(`/api/reports/${own!.id}`).set(auth(inst)).expect(200)).body.instructorId).toBe(instId);
    await http.get(`/api/reports/${foreign!.id}`).set(auth(inst)).expect(403); // 종전엔 200(IDOR)
    await http.get(`/api/reports/${foreign!.id}`).set(auth(admin)).expect(200); // 관리자는 전체
  });

  it('강사 보고서·출결 조회도 본인 일반 일정 술어를 공유하고 상담 세션을 누출하지 않는다', async () => {
    const counselSession = (await http.post('/api/schedule').set(auth(admin)).send({
      courseId: 10, instructorId: instId, sessionDate: '2098-03-01', startTime: '05:00', durationMinutes: 60,
      kind: 'counsel', force: true,
    }).expect(201)).body.row;
    const report = (await http.post('/api/reports').set(auth(admin)).send({
      sessionId: counselSession.id, studentId: 1, content: '관리자 상담 기록', status: 'draft',
    }).expect(201)).body;

    const visibleReports = (await http.get('/api/reports').set(auth(inst)).expect(200)).body;
    expect(visibleReports.some((row: { id: number }) => row.id === report.id)).toBe(false);
    await http.get(`/api/reports?sessionId=${counselSession.id}`).set(auth(inst)).expect(403);
    await http.get(`/api/reports/${report.id}`).set(auth(inst)).expect(403);
    await http.get(`/api/attendance?sessionId=${counselSession.id}`).set(auth(inst)).expect(403);
    await http.put('/api/attendance').set(auth(inst))
      .send({ sessionId: counselSession.id, studentId: 1, status: 'present' }).expect(403);

    await http.delete(`/api/schedule/${counselSession.id}`).set(auth(admin)).expect(200);
  });
});
