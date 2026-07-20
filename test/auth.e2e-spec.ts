import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { signupWithOtp } from './signup-helper';

// 인증 e2e — [TBO-31 C1] 가입 전 이메일 OTP → 가입신청(emailVerified=true) → 대표 승인 → 로그인 게이트.
describe('Auth API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => { await app.close(); });

  // 데모 시드 super_admin 로그인 → 토큰(가드 테스트용)
  async function superToken(): Promise<string> {
    const res = await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    return res.body.accessToken;
  }

  it('시드 계정 로그인 성공 + 토큰 발급', async () => {
    const res = await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.account).toMatchObject({ name: '김민수', role: 'super_admin' });
  });

  it('잘못된 비밀번호 → 401', async () => {
    await http.post('/api/auth/login').send({ webId: 'admin', password: 'wrong' }).expect(401);
  });

  it('가입 신청(OTP 인증 소비) → pending — 인증 링크·devVerifyLink는 더 이상 없다', async () => {
    const res = await signupWithOtp(http, { webId: 'newinst', name: '새강사', email: 'new@tnacademy.test', role: 'instructor' });
    expect(res.account.status).toBe('pending');
    // [TBO-31 C1 D1] 48h 링크 단계 소멸 — 응답에 devVerifyLink 없음
    expect((res as Record<string, unknown>).devVerifyLink).toBeUndefined();
  });

  it('미승인(pending) 상태 로그인 차단(403) — 가입 즉시 emailVerified=true라도 승인 전엔 불가', async () => {
    await signupWithOtp(http, { webId: 'pend1', name: '대기', email: 'pend1@t.test' });
    await http.post('/api/auth/login').send({ webId: 'pend1', password: 'password123' }).expect(403); // 대표 승인 대기
  });

  it('전체 흐름: OTP 인증 → 신청 → 승인 → 로그인 성공', async () => {
    await signupWithOtp(http, { webId: 'flow1', name: '흐름', email: 'flow1@t.test', role: 'manager' });
    // 가입 즉시 emailVerified=true — 그러나 아직 미승인 → 403
    await http.post('/api/auth/login').send({ webId: 'flow1', password: 'password123' }).expect(403);

    // 대표 승인
    const admin = await superToken();
    const pending = (await http.get('/api/auth/pending').set('Authorization', `Bearer ${admin}`).expect(200)).body;
    const target = pending.find((p: { webId: string }) => p.webId === 'flow1');
    expect(target).toBeTruthy();
    await http.post(`/api/auth/approve/${target.id}`).set('Authorization', `Bearer ${admin}`).send({ role: 'manager' }).expect(201);

    // 이제 로그인 성공
    const login = (await http.post('/api/auth/login').send({ webId: 'flow1', password: 'password123' }).expect(201)).body;
    expect(login.account.role).toBe('manager');
  });

  it('production login 응답은 access token을 노출하지 않고 Secure HttpOnly cookie만 발급한다', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const response = await http.post('/api/auth/login')
        .set('Origin', 'https://taco-frontend-tau.vercel.app')
        .send({ webId: 'flow1', password: 'password123' })
        .expect(201);
      expect(response.body.accessToken).toBeUndefined();
      const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
      const access = cookies.find((line) => line.startsWith('access_token='));
      expect(access).toContain('HttpOnly');
      expect(access).toContain('Secure');
      expect(access).toContain('SameSite=Lax');
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });

  it('super_admin 가드: 토큰 없이 승인목록 → 401', async () => {
    await http.get('/api/auth/pending').expect(401);
  });

  it('super_admin 가드: 비대표 토큰으로 승인목록 → 403', async () => {
    // park_inst(instructor) 로그인
    const inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.get('/api/auth/pending').set('Authorization', `Bearer ${inst}`).expect(403);
  });

  // [TBO-29C 계정 청크] demo 자격증명 방어 — 운영(NODE_ENV=production)에서는 demo 비밀번호 로그인을
  //  계정 존재 여부와 무관하게 즉시 거부(심층 방어 — 토글형 계정 전환 폐지의 백엔드 짝).
  it('production에서 demo 비밀번호 로그인은 즉시 거부(demo_credential_blocked)', async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await http.post('/api/auth/login')
        .set('Origin', 'https://taco-frontend-tau.vercel.app')
        .send({ webId: 'admin', password: 'demo1234' })
        .expect(401);
      const db = app.get((await import('../src/database/in-memory.database')).InMemoryDatabase);
      const blocked = db.findAll<{ eventType: string; failureCode?: string }>('auth_events')
        .filter((e) => e.eventType === 'login_failure' && e.failureCode === 'demo_credential_blocked');
      expect(blocked.length).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
    // 테스트 모드로 복귀하면 기존 demo 로그인은 그대로 동작(개발/CI 편의 유지)
    await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
  });
});
