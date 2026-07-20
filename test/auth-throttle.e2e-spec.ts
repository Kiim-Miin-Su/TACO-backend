// [TBO-28B] /auth/login rate limit e2e — THROTTLE_E2E=1로 명시 활성(다른 스펙은 NODE_ENV=test에서 skip).
//  proxy tracker 검증: x-forwarded-for 첫 IP 기준 카운트(Vercel 프록시 환경 대응).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Auth login throttling (e2e, TBO-28B)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    process.env.THROTTLE_E2E = '1';
    process.env.TRUST_PROXY = '1';
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    delete process.env.THROTTLE_E2E;
    delete process.env.TRUST_PROXY;
    await app.close();
  });

  it('10회/60초 초과 시 429 + 다른 IP(x-forwarded-for)는 독립 카운트', async () => {
    // 같은 IP에서 10회(한도 내) — 결과는 401(자격 오류)이지만 카운트는 쌓인다
    for (let i = 0; i < 10; i++) {
      await http.post('/api/auth/login')
        .set('x-forwarded-for', '203.0.113.10')
        .send({ webId: 'admin', password: 'wrongpass' })
        .expect(401);
    }
    // 11번째 → 429 (자격이 맞아도 차단)
    await http.post('/api/auth/login')
      .set('x-forwarded-for', '203.0.113.10')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(429);
    // 다른 IP는 영향 없음 — 정상 로그인
    await http.post('/api/auth/login')
      .set('x-forwarded-for', '203.0.113.99')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);
  });

  it('로그인 외 라우트는 스로틀 미적용', async () => {
    const token = (await http.post('/api/auth/login')
      .set('x-forwarded-for', '203.0.113.50')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201)).body.accessToken;
    for (let i = 0; i < 15; i++) {
      await http.get('/api/auth/me').set('Authorization', `Bearer ${token}`).set('x-forwarded-for', '203.0.113.50').expect(200);
    }
  });
});
