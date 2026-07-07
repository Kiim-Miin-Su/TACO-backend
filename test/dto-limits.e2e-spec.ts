import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// [무결성 감사 2026-07-07] 전 모듈 DTO 상한(자유텍스트 @MaxLength·금액 @Max) 회귀 가드.
//  common/validation-limits(TEXT·MAX_AMOUNT·MAX_COUNT) 단일 소스 적용을 대표 라우트로 실증.
describe('DTO 상한 하드닝 (e2e) [무결성]', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const AH = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('expenses: title 상한(100) 초과 → 400 · 정상 길이 → 201', async () => {
    const base = { category: 'etc', amount: 1000, spentAt: '2026-07-07' };
    await http.post('/api/expenses').set(AH()).send({ ...base, title: 'x'.repeat(101) }).expect(400);
    await http.post('/api/expenses').set(AH()).send({ ...base, title: 'x'.repeat(100), memo: 'm'.repeat(500) }).expect(201);
    await http.post('/api/expenses').set(AH()).send({ ...base, title: 'ok', memo: 'm'.repeat(501) }).expect(400); // memo 상한(500)
  });

  it('events: title 상한(100) 초과 → 400', async () => {
    await http.post('/api/events').set(AH())
      .send({ title: 't'.repeat(101), type: 'notice', startDate: '2026-07-07', endDate: '2026-07-07' }).expect(400);
  });

  it('courses: price 상한(1억) 초과 → 400', async () => {
    await http.post('/api/courses').set(AH())
      .send({ name: '테스트코스', subjectId: 1, instructorId: 1, price: 100_000_001, hourlyRate: 1000 }).expect(400);
  });

  it('parents: name 상한(100) 초과 → 400', async () => {
    await http.post('/api/parents').set(AH())
      .send({ name: 'n'.repeat(101), studentId: 1 }).expect(400);
  });

  it('roadmaps: description 상한(2000) 초과 → 400', async () => {
    await http.post('/api/roadmaps').set(AH())
      .send({ title: 'ok', description: 'd'.repeat(2001) }).expect(400);
  });
});
