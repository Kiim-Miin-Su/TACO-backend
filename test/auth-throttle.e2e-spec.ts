// [TBO-28B] /auth/login rate limit e2e — THROTTLE_E2E=1로 명시 활성(다른 스펙은 NODE_ENV=test에서 skip).
//  proxy tracker 검증: x-forwarded-for 첫 IP 기준 카운트(Vercel 프록시 환경 대응).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Auth login throttling (e2e, TBO-28B)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  /**
   * [TBO-79 K3] **시도별 유일 tracker.** 종전엔 고정 IP(`203.0.113.10` 등)를 썼고, 그래서
   * `jest.retryTimes(1)`이 **구조적으로 이 스위트를 복구할 수 없었다**: 스로틀 카운터는
   * `beforeAll`에서 만든 앱 인스턴스 안에 살고 재시도는 `beforeAll`을 다시 돌리지 않으므로,
   * 1차 시도가 한도 10을 이미 소진한 상태에서 2차 시도는 **첫 요청부터 429**가 된다.
   * 2026-07-30 대표 release 실측이 정확히 그것이다 — 1차 실패(원인 별건) → 재시도가 429로
   * 결정론적 실패 → 스위트 FAIL. green이 뜬 건 재시도가 아니라 **스위트 전체 재실행**(fresh 앱)
   * 덕이었다. OTP 쿨다운 건(§79J-2)과 같은 부류의 결함이다.
   *
   * 시도마다 IP를 바꾸면 각 시도가 빈 카운터로 시작한다. 이 스위트의 주제 자체가 "IP별 독립
   * 카운트"이므로 IP를 변수로 두는 것은 의미를 훼손하지 않고 그 성질을 이용하는 것이다.
   * `beforeEach`는 재시도마다 다시 실행되지만 `beforeAll`은 아니라는 점이 설계 근거다.
   * 슬롯 간격 50 — 시도 100회까지 슬롯끼리 충돌하지 않고 203.0.113.0/24(TEST-NET-3)에 머문다.
   */
  let attempt = 0;
  const ip = (slot: 1 | 2 | 3): string => `203.0.113.${slot * 50 + attempt}`;

  beforeAll(async () => {
    process.env.THROTTLE_E2E = '1';
    process.env.TRUST_PROXY = '1';
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  beforeEach(() => {
    attempt += 1;
  });
  afterAll(async () => {
    delete process.env.THROTTLE_E2E;
    delete process.env.TRUST_PROXY;
    await app.close();
  });

  it('10회/60초 초과 시 429 + 다른 IP(x-forwarded-for)는 독립 카운트', async () => {
    const throttled = ip(1);
    // 같은 IP에서 10회(한도 내) — 결과는 401(자격 오류)이지만 카운트는 쌓인다
    for (let i = 0; i < 10; i++) {
      await http.post('/api/auth/login')
        .set('x-forwarded-for', throttled)
        .send({ webId: 'admin', password: 'wrongpass' })
        .expect(401);
    }
    // 11번째 → 429 (자격이 맞아도 차단)
    await http.post('/api/auth/login')
      .set('x-forwarded-for', throttled)
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(429);
    // 다른 IP는 영향 없음 — 정상 로그인
    await http.post('/api/auth/login')
      .set('x-forwarded-for', ip(2))
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);
  });

  it('로그인 외 라우트는 스로틀 미적용', async () => {
    const client = ip(3);
    const token = (await http.post('/api/auth/login')
      .set('x-forwarded-for', client)
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201)).body.accessToken;
    for (let i = 0; i < 15; i++) {
      await http.get('/api/auth/me').set('Authorization', `Bearer ${token}`).set('x-forwarded-for', client).expect(200);
    }
  });
});
