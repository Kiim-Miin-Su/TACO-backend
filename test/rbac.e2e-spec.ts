import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// ─────────────────────────────────────────────────────────────
// RBAC 하드닝 검증 e2e — 쓰기 엔드포인트 대표 표본에 대해:
//  (a) 토큰 없음 → 401
//  (b) 강사(instructor) 토큰 → ADMIN_ROLES 엔드포인트는 403(students/courses/parents),
//      STAFF_ROLES 엔드포인트는 통과(availability)
//  (c) 관리자(admin) 토큰 → 성공(2xx)
// 로그인: admin(관리자), park_inst(강사). 비밀번호는 데모 공통(demo1234).
// ─────────────────────────────────────────────────────────────
describe('RBAC hardening (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  let INST = '';
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    INST = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  // 유효 본문(검증 통과) — 인가만 순수하게 확인하기 위함.
  const studentBody = { name: 'RBAC 테스트학생' };
  const courseBody = { name: 'RBAC 테스트강좌', subjectId: 1, instructorId: 1, price: 100000, hourlyRate: 50000 };
  const parentBody = { name: 'RBAC 보호자', studentId: 3 };
  const availBody = { ownerType: 'instructor', ownerId: 1, kind: 'unavailable', weekday: 2, startTime: '16:00', endTime: '17:00' };

  const expect2xx = (status: number) => {
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
  };

  describe('POST /api/students (ADMIN_ROLES)', () => {
    it('토큰 없음 → 401', () => http.post('/api/students').send(studentBody).expect(401));
    it('강사 토큰 → 403', () => http.post('/api/students').set(bearer(INST)).send(studentBody).expect(403));
    it('관리자 토큰 → 2xx', async () => {
      const res = await http.post('/api/students').set(bearer(ADMIN)).send(studentBody);
      expect2xx(res.status);
    });
  });

  describe('POST /api/courses (ADMIN_ROLES)', () => {
    it('토큰 없음 → 401', () => http.post('/api/courses').send(courseBody).expect(401));
    it('강사 토큰 → 403', () => http.post('/api/courses').set(bearer(INST)).send(courseBody).expect(403));
    it('관리자 토큰 → 2xx', async () => {
      const res = await http.post('/api/courses').set(bearer(ADMIN)).send(courseBody);
      expect2xx(res.status);
    });
  });

  describe('POST /api/parents (ADMIN_ROLES)', () => {
    it('토큰 없음 → 401', () => http.post('/api/parents').send(parentBody).expect(401));
    it('강사 토큰 → 403', () => http.post('/api/parents').set(bearer(INST)).send(parentBody).expect(403));
    it('관리자 토큰 → 2xx', async () => {
      const res = await http.post('/api/parents').set(bearer(ADMIN)).send(parentBody);
      expect2xx(res.status);
    });
  });

  describe('PUT /api/availability (STAFF_ROLES)', () => {
    it('토큰 없음 → 401', () => http.put('/api/availability').send(availBody).expect(401));
    it('강사 토큰 → 본인 강사 owner만 통과(2xx)', async () => {
      const res = await http.put('/api/availability').set(bearer(INST)).send(availBody);
      expect2xx(res.status);
    });
    it('강사 토큰 → 타 강사/학생/강의실 owner는 403', async () => {
      await http.put('/api/availability').set(bearer(INST))
        .send({ ...availBody, ownerId: 2, weekday: 6, startTime: '08:00', endTime: '09:00' }).expect(403);
      await http.put('/api/availability').set(bearer(INST))
        .send({ ownerType: 'student', ownerId: 1, kind: 'available', weekday: 6, startTime: '09:00', endTime: '10:00' }).expect(403);
      await http.put('/api/availability').set(bearer(INST))
        .send({ ownerType: 'room', ownerId: 1, kind: 'unavailable', weekday: 6, startTime: '10:00', endTime: '11:00' }).expect(403);
    });
    it('관리자 토큰 → 2xx', async () => {
      // 강사 케이스와 겹치지 않는 별도 블록(다른 요일)으로 인가만 순수 확인.
      const adminBlock = { ownerType: 'instructor', ownerId: 1, kind: 'unavailable', weekday: 4, startTime: '16:00', endTime: '17:00' };
      const res = await http.put('/api/availability').set(bearer(ADMIN)).send(adminBlock);
      expect2xx(res.status);
    });
  });
});
