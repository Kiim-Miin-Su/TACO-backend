// [TBO-58 P2 2026-07-24] 수강 등록 홈 스위트 — 종전엔 다른 스위트(catalog·students)에 분산 커버라
//  enrollments 관점의 권한·중복 방지·FK 실패 경로가 응집 검증되지 않았다(검증③ 실측).
//  픽스처: enrollment(student 1 × course 10) 존재 — 중복 409의 결정론 근거.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('[TBO-58] enrollments 홈 스위트 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('읽기 — 전 직원 200, 비로그인 401, studentId 필터 동작', async () => {
    await http.get('/api/enrollments').expect(401);
    const all = (await http.get('/api/enrollments').set(auth('park_inst')).expect(200)).body as Array<{ id: number; studentId: number }>;
    expect(all.length).toBeGreaterThan(0);
    const filtered = (await http.get('/api/enrollments?studentId=1').set(auth('manager')).expect(200)).body as Array<{ studentId: number }>;
    expect(filtered.length).toBeGreaterThan(0);
    for (const row of filtered) expect(row.studentId).toBe(1);
    // 단건 — 존재 200 / 부재 404
    await http.get(`/api/enrollments/${all[0].id}`).set(auth('park_inst')).expect(200);
    await http.get('/api/enrollments/999999').set(auth('manager')).expect(404);
  });

  it('생성 권한 — 매니저 이상만(강사 403)', async () => {
    await http.post('/api/enrollments').set(auth('park_inst')).send({ studentId: 3, courseId: 12 }).expect(403);
    await http.patch('/api/enrollments/1').set(auth('park_inst')).send({ status: 'paused', reason: '강사 임의 변경' }).expect(403);
  });

  it('중복 등록 방지 — 같은 (학생, 코스) 재등록 409', async () => {
    // 픽스처: student 1 × course 10 이미 등록 → 409(재등록 차단)
    const res = await http.post('/api/enrollments').set(auth('manager')).send({ studentId: 1, courseId: 10 }).expect(409);
    expect(String(res.body.message)).toContain('이미 연결');
  });

  it('FK 실패 경로 — 없는 학생/코스 400, 스키마 위반 400', async () => {
    await http.post('/api/enrollments').set(auth('manager')).send({ studentId: 999999, courseId: 10 }).expect(400);
    await http.post('/api/enrollments').set(auth('manager')).send({ studentId: 1, courseId: 999999 }).expect(400);
    await http.post('/api/enrollments').set(auth('manager')).send({ studentId: 'abc', courseId: 10 }).expect(400); // 타입 위반
    await http.post('/api/enrollments').set(auth('manager')).send({ studentId: 1, courseId: 12, hacker: true }).expect(400); // 미허용 필드(forbidNonWhitelisted)
  });

  it('정상 생성 — 미등록 조합은 201(active·completedSessions=0) 후 즉시 중복 409', async () => {
    // 픽스처에 없는 조합: student 3(박지민 — 미수강) × course 12
    const row = (await http.post('/api/enrollments').set(auth('manager')).send({ studentId: 3, courseId: 12, totalSessions: 8 }).expect(201)).body;
    expect(row.status).toBe('active');
    expect(row.completedSessions).toBe(0);
    expect(row.totalSessions).toBe(8);
    await http.post('/api/enrollments').set(auth('manager')).send({ studentId: 3, courseId: 12 }).expect(409); // 방금 만든 조합 재등록 차단
    const listed = (await http.get('/api/enrollments?studentId=3').set(auth('manager')).expect(200)).body as Array<{ id: number }>;
    expect(listed.some((e) => e.id === row.id)).toBe(true);

    const paused = (await http.patch(`/api/enrollments/${row.id}`).set(auth('manager'))
      .send({ status: 'paused', startDate: '2026-07-29', endDate: '2026-08-29', memo: '여름 방학', reason: '보호자 휴강 요청' })
      .expect(200)).body;
    expect(paused).toMatchObject({
      id: row.id,
      status: 'paused',
      startDate: '2026-07-29',
      endDate: '2026-08-29',
      memo: '여름 방학',
    });
    const readback = (await http.get(`/api/enrollments/${row.id}`).set(auth('manager')).expect(200)).body;
    expect(readback).toMatchObject({ status: 'paused', startDate: '2026-07-29', endDate: '2026-08-29' });

    const audits = app.get(InMemoryDatabase)
      .findAll<{ entity: string; entityId: number; action: string; reason?: string }>('audit_log')
      .filter((audit) => audit.entity === 'enrollments' && audit.entityId === row.id);
    expect(audits.map((audit) => audit.action)).toEqual(['create', 'update']);
    expect(audits.at(-1)?.reason).toBe('보호자 휴강 요청');
  });

  it('수정 입력·전이 무결성 — 이유/날짜/완료회차/없는 행을 fail-closed', async () => {
    await http.patch('/api/enrollments/1').set(auth('manager'))
      .send({ status: 'paused', reason: '' }).expect(400);
    await http.patch('/api/enrollments/1').set(auth('manager'))
      .send({ startDate: '2026-08-02', endDate: '2026-08-01', reason: '기간 교정' }).expect(400);
    await http.patch('/api/enrollments/1').set(auth('manager'))
      .send({ totalSessions: 0, reason: '회차 교정' }).expect(400);
    await http.patch('/api/enrollments/999999').set(auth('manager'))
      .send({ status: 'paused', reason: '부재 확인' }).expect(404);
    await http.patch('/api/enrollments/1').set(auth('manager'))
      .send({ status: 'invalid', reason: '상태 검증' }).expect(400);
  });
});
