import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 인증 e2e — 가입신청 → 이메일 인증 → 대표 승인 → 로그인 게이트, super_admin 가드.
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

  it('가입 신청 → pending + devVerifyLink(SMTP 미설정)', async () => {
    const res = await http.post('/api/auth/signup')
      .send({ webId: 'newinst', name: '새강사', email: 'new@tnacademy.test', password: 'password123', role: 'instructor' })
      .expect(201);
    expect(res.body.account.status).toBe('pending');
    expect(res.body.devVerifyLink).toContain('token=');
  });

  it('미인증·미승인 상태 로그인 차단(403)', async () => {
    await http.post('/api/auth/signup').send({ webId: 'pend1', name: '대기', email: 'pend1@t.test', password: 'password123' }).expect(201);
    await http.post('/api/auth/login').send({ webId: 'pend1', password: 'password123' }).expect(403); // 이메일 미인증
  });

  it('전체 흐름: 신청 → 이메일 인증 → 승인 → 로그인 성공', async () => {
    const signup = (await http.post('/api/auth/signup')
      .send({ webId: 'flow1', name: '흐름', email: 'flow1@t.test', password: 'password123', role: 'manager' })
      .expect(201)).body;
    const token = new URL(signup.devVerifyLink).searchParams.get('token')!;

    // 이메일 인증
    await http.get(`/api/auth/verify-email?token=${token}`).expect(200);
    // 인증했지만 아직 미승인 → 403
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

  it('super_admin 가드: 토큰 없이 승인목록 → 401', async () => {
    await http.get('/api/auth/pending').expect(401);
  });

  it('super_admin 가드: 비대표 토큰으로 승인목록 → 403', async () => {
    // park_inst(instructor) 로그인
    const inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.get('/api/auth/pending').set('Authorization', `Bearer ${inst}`).expect(403);
  });
});
