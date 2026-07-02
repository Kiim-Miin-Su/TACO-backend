import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// ─────────────────────────────────────────────────────────────
// [감사 A 회귀] 스케줄 코호트 = 실제 students/enrollments 컬렉션(단일 소스).
//  이전 버그: 하드코딩 상수(STUDENTS_LBL/COURSE_STUDENTS) + 존재하지 않는 'drop' 필터라
//  학생 소프트삭제·신규 수강 등록이 캘린더(studentIds·resources)에 반영되지 않았다.
//  검증: ① 시드 코호트 정합 ② 신규 학생+수강 → 즉시 코호트·resources 반영
//        ③ 학생 소프트삭제(canceled) → 코호트·resources·개인스케줄 필터에서 즉시 제외.
// ─────────────────────────────────────────────────────────────
describe('Schedule cohort integrity (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });
  let newStudentId = 0;

  const course10Rows = async () =>
    (await http.get('/api/schedule').expect(200)).body.filter((r: { courseId: number }) => r.courseId === 10);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('시드: 코스10 코호트 = enrollments 시드(학생 1·4)와 일치', async () => {
    const rows = await course10Rows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect([...r.studentIds].sort()).toEqual([1, 4]);
    // 이름도 students 컬렉션에서 조인
    expect(rows[0].studentNames.sort()).toEqual(['김서연', '최민준']);
  });

  it('신규 학생 + 코스10 수강 등록 → 코호트·resources에 즉시 반영', async () => {
    newStudentId = (
      await http.post('/api/students').set(asAdmin()).send({ name: '테스트학생', grade: 9, status: 'active' }).expect(201)
    ).body.id;
    await http.post('/api/enrollments').set(asAdmin())
      .send({ studentId: newStudentId, courseId: 10, totalSessions: 8 }).expect(201);

    const rows = await course10Rows();
    for (const r of rows) expect(r.studentIds).toContain(newStudentId);
    const res = (await http.get('/api/schedule/resources').expect(200)).body;
    expect(res.students.map((s: { id: number }) => s.id)).toContain(newStudentId);
    // 개인 스케줄 필터(studentId)도 enrollments 역추적으로 동작
    const mine = (await http.get(`/api/schedule?studentId=${newStudentId}`).expect(200)).body;
    expect(mine.length).toBe(rows.length);
    expect(mine.every((r: { courseId: number }) => r.courseId === 10)).toBe(true);
  });

  it('학생 소프트삭제(canceled) → 코호트·resources·개인 스케줄에서 즉시 제외(이력은 보존)', async () => {
    await http.delete(`/api/students/${newStudentId}`).set(asAdmin()).expect(200);

    const rows = await course10Rows();
    for (const r of rows) expect(r.studentIds).not.toContain(newStudentId);
    const res = (await http.get('/api/schedule/resources').expect(200)).body;
    expect(res.students.map((s: { id: number }) => s.id)).not.toContain(newStudentId);
    const mine = (await http.get(`/api/schedule?studentId=${newStudentId}`).expect(200)).body;
    expect(mine.length).toBe(0);
    // 소프트삭제 — 학생 행 자체는 보존(status만 canceled)
    const all = (await http.get('/api/students').expect(200)).body;
    const st = all.find((s: { id: number }) => s.id === newStudentId);
    expect(st).toBeDefined();
    expect(st.status).toBe('canceled');
    // 기존 코호트(1·4)는 영향 없음
    for (const r of rows) expect([...r.studentIds].sort()).toEqual([1, 4]);
  });
});
