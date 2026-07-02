import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// ─────────────────────────────────────────────────────────────
// 학생(students) 소프트 삭제 e2e.
//  DELETE /students/:id → 학생 status=canceled + 해당 학생 수강 canceled(무결성).
//  없는 학생 삭제 → 404.
// ─────────────────────────────────────────────────────────────
describe('Students Soft-Delete (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const S1 = 1; // 김서연 — 시드상 수강 2건(enrollment 1, 4)
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('DELETE 기존 학생 → status=canceled', async () => {
    // 사전: 학생1은 active, 수강 2건 active
    const before = (await http.get(`/api/students/${S1}`).expect(200)).body;
    expect(before.status).toBe('active');
    const enrBefore = (await http.get('/api/enrollments').expect(200)).body
      .filter((e: { studentId: number }) => e.studentId === S1);
    expect(enrBefore.length).toBeGreaterThan(0);

    const res = await http.delete(`/api/students/${S1}`).set(asAdmin()).expect(200);
    expect(res.body.status).toBe('canceled');

    // 학생 상태 반영
    const after = (await http.get(`/api/students/${S1}`).expect(200)).body;
    expect(after.status).toBe('canceled');

    // 해당 학생 수강 전부 canceled
    const enrAfter = (await http.get('/api/enrollments').expect(200)).body
      .filter((e: { studentId: number }) => e.studentId === S1);
    expect(enrAfter.length).toBe(enrBefore.length);
    for (const e of enrAfter) expect(e.status).toBe('canceled');
  });

  it('DELETE 없는 학생 → 404', async () => {
    await http.delete('/api/students/99999').set(asAdmin()).expect(404);
  });
});
