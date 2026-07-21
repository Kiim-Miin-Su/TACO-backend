import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { AuditService } from '../src/modules/audit/audit.service';

// ─────────────────────────────────────────────────────────────
// 학생(students) 퇴원 호환 DELETE e2e.
//  DELETE /students/:id → 학생 status=withdrawn + 해당 학생 수강 canceled(무결성).
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

  it('DELETE 기존 학생 → status=withdrawn', async () => {
    // 사전: 학생1은 enrolled, 수강 2건 active
    const before = (await http.get(`/api/students/${S1}`).set(asAdmin()).expect(200)).body;
    expect(before.status).toBe('enrolled');
    const enrBefore = (await http.get('/api/enrollments').set(asAdmin()).expect(200)).body
      .filter((e: { studentId: number }) => e.studentId === S1);
    expect(enrBefore.length).toBeGreaterThan(0);

    const res = await http.delete(`/api/students/${S1}`).set(asAdmin()).expect(200);
    expect(res.body.status).toBe('withdrawn');

    // 학생 상태 반영
    const after = (await http.get(`/api/students/${S1}`).set(asAdmin()).expect(200)).body;
    expect(after.status).toBe('withdrawn');

    // 해당 학생 수강 전부 canceled
    const enrAfter = (await http.get('/api/enrollments').set(asAdmin()).expect(200)).body
      .filter((e: { studentId: number }) => e.studentId === S1);
    expect(enrAfter.length).toBe(enrBefore.length);
    for (const e of enrAfter) expect(e.status).toBe('canceled');
  });

  it('DELETE 없는 학생 → 404', async () => {
    await http.delete('/api/students/99999').set(asAdmin()).expect(404);
  });

  it('프로필 입력을 컬럼 계약대로 저장하고 유효하지 않은 날짜·성별·상태는 400으로 차단한다', async () => {
    const payload = {
      name: '프로필학생', gender: 'undisclosed', birthDate: '2012-07-21', grade: 8,
      country: 'US', residenceType: 'overseas', address: 'Seattle', addressDetail: 'Unit 3',
      schoolName: 'TACO School', phone: '+1-206-555-0100', kakaoId: 'masked-user',
      counselTopic: 'Writing 집중 상담', status: 'new_inquiry',
    };
    const created = (await http.post('/api/students').set(asAdmin()).send(payload).expect(201)).body;
    expect(created).toMatchObject(payload);
    expect((await http.get(`/api/students/${created.id}`).set(asAdmin()).expect(200)).body).toMatchObject(payload);

    await http.post('/api/students').set(asAdmin()).send({ name: '날짜오류', birthDate: '2012-02-30' }).expect(400);
    await http.post('/api/students').set(asAdmin()).send({ name: '성별오류', gender: 'unknown' }).expect(400);
    await http.post('/api/students').set(asAdmin()).send({ name: '상태오류', status: 'active' }).expect(400);
  });

  it('학생 PII는 감사 diff에서 원문 대신 마스킹된다', () => {
    const masked = app.get(AuditService).maskContactPii({
      phone: { before: '010-1111-2222', after: '010-3333-4444' },
      birthDate: { after: '2012-07-21' }, address: { after: '서울시' },
      addressDetail: { after: '101호' }, kakaoId: { after: 'student-kakao' },
      name: { after: '학생명' },
    });
    expect(masked).toEqual({
      phone: { before: '[masked]', after: '[masked]' },
      birthDate: { after: '[masked]' }, address: { after: '[masked]' },
      addressDetail: { after: '[masked]' }, kakaoId: { after: '[masked]' },
      name: { after: '학생명' },
    });
  });
});
