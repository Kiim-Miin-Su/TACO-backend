// [TBO-80 80J F-3] 미정산 감지 스캔 vs 비활성 강사 — 반려 가입 1건이 목록 전체를 400으로
//  죽이던 결함의 회귀. 이빨: 수정 전 코드에서 ②가 400으로 실패(시뮬레이션 QA 라이브 재현 —
//  uncovered가 role=instructor 전체를 순회하며 measure()의 활성 가드에 걸림).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('GET /payouts/uncovered — 비활성(반려) 강사 내성 (TBO-80 80J F-3)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: string;
  let rejectedId: number;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;

    // 반려된 강사 가입 생성(OTP → signup → reject) — 시뮬레이션과 동일 경로
    const email = 'uncovered-reject@t80.test';
    const ch = (await http.post('/api/auth/signup-email-challenge').send({ email }).expect(201)).body;
    await http.post(`/api/auth/signup-email-challenge/${ch.id}/confirm`).send({ email, code: ch.devOtpCode }).expect(201);
    const su = (await http.post('/api/auth/signup').send({
      webId: 't80_rejected', name: '반려강사', englishName: 'Rejected Instructor', email, password: 'password123',
      rrn: '910101-1234567', emailChallengeId: ch.id, role: 'instructor',
    }).expect(201)).body;
    rejectedId = su.account.id;
    await http.post(`/api/auth/reject/${rejectedId}`).set({ Authorization: `Bearer ${admin}` })
      .send({ reason: '경력 증빙 미비 — F-3 회귀 픽스처' }).expect(201);
  });
  afterAll(async () => { await app.close(); });

  it('① 픽스처: role=instructor·status=rejected 계정이 존재한다', async () => {
    const denied = await http.post('/api/auth/login').send({ webId: 't80_rejected', password: 'password123' });
    expect(denied.status).toBe(403);
  });

  it('② 반려 강사가 있어도 uncovered 목록은 200이다(스캔은 가드 없는 코어 — 자연 배제)', async () => {
    const res = await http.get('/api/payouts/uncovered').set({ Authorization: `Bearer ${admin}` }).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    // 반려 강사는 수업이 없어 어느 월에도 잡히지 않는다(자연 배제 전제의 코드화)
    expect(res.body.every((row: { instructorId: number }) => row.instructorId !== rejectedId)).toBe(true);
  });

  it('③ 라우트 가드 보존: 반려 강사 대상 preview는 여전히 400', async () => {
    await http.get('/api/payouts/preview')
      .query({ instructorId: rejectedId, from: '2026-07-01', to: '2026-07-31' })
      .set({ Authorization: `Bearer ${admin}` }).expect(400);
  });
});
