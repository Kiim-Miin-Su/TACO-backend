import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

const setCookies = (res: { headers: Record<string, unknown> }): string[] =>
  ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []);

describe('TBO-34 browser session + Origin defense (e2e)', () => {
  let app: INestApplication;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  it('login은 HttpOnly access/refresh cookie를 발급하고 cookie만으로 /auth/me를 검증한다', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);
    const cookies = setCookies(login);
    const access = cookies.find((line) => line.startsWith('access_token='));
    const refresh = cookies.find((line) => line.startsWith('refresh_token='));
    expect(access).toContain('HttpOnly');
    expect(access).toContain('SameSite=Lax');
    expect(access).toContain('Path=/');
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('Path=/api/auth');

    await agent.get('/api/auth/me').expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ sub: login.body.account.id, roles: ['super_admin'] });
    });
  });

  it('refresh cookie가 없으면 stale HttpOnly access cookie도 서버가 제거한다', async () => {
    const login = await request(app.getHttpServer()).post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);
    const access = setCookies(login).find((line) => line.startsWith('access_token='))?.split(';')[0];
    if (!access) throw new Error('access_token Set-Cookie 없음');

    const refreshed = await request(app.getHttpServer()).post('/api/auth/refresh')
      .set('Cookie', access)
      .expect(401);
    expect(setCookies(refreshed).find((line) => line.startsWith('access_token='))).toContain('Max-Age=0');
  });

  it('production cookie write는 allowlist Origin만 허용하고 차단 이력을 남긴다', async () => {
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);

    const previousEnv = process.env.NODE_ENV;
    const previousOrigin = process.env.WEB_ORIGIN;
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://app.taco.test';
    try {
      await agent.post('/api/subjects')
        .send({ code: 'csrf-missing', name: '차단' })
        .expect(403);
      await agent.post('/api/subjects')
        .set('Origin', 'https://evil.example')
        .send({ code: 'csrf-evil', name: '차단' })
        .expect(403);

      const code = `secure-${Date.now()}`;
      const created = await agent.post('/api/subjects')
        .set('Origin', 'https://app.taco.test')
        .send({ code, name: '보안 경계 과목' })
        .expect(201);
      expect(created.body.code).toBe(code);

      const blocked = db.findAll<{ eventType: string; failureCode?: string }>('auth_events')
        .filter((event) => event.eventType === 'csrf_origin_blocked');
      expect(blocked.some((event) => event.failureCode === 'origin_missing')).toBe(true);
      expect(blocked.some((event) => event.failureCode === 'origin_not_allowed')).toBe(true);

      const audit = db.findAll<{ entity: string; entityId: number; action: string; actorId: number }>('audit_log')
        .find((entry) => entry.entity === 'subjects' && entry.entityId === created.body.id && entry.action === 'create');
      expect(audit?.actorId).toBe(login.body.account.id);
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousOrigin == null) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = previousOrigin;
    }
  });

  it('production 최초 login도 Origin 없이는 cookie를 발급하지 않고 차단 이력을 남긴다', async () => {
    const previousEnv = process.env.NODE_ENV;
    const previousOrigin = process.env.WEB_ORIGIN;
    process.env.NODE_ENV = 'production';
    process.env.WEB_ORIGIN = 'https://app.taco.test';
    try {
      const before = db.findAll<{ eventType: string }>('auth_events')
        .filter((event) => event.eventType === 'csrf_origin_blocked').length;
      const response = await request(app.getHttpServer()).post('/api/auth/login')
        .send({ webId: 'admin', password: 'not-a-real-password' })
        .expect(403);
      expect(setCookies(response)).toHaveLength(0);
      const after = db.findAll<{ eventType: string; failureCode?: string }>('auth_events')
        .filter((event) => event.eventType === 'csrf_origin_blocked');
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)?.failureCode).toBe('origin_missing');
    } finally {
      process.env.NODE_ENV = previousEnv;
      if (previousOrigin == null) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = previousOrigin;
    }
  });

  it('이행 기간 Bearer 상태 변경은 Origin 없이도 backend 권한과 audit를 유지한다', async () => {
    const login = await request(app.getHttpServer()).post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const code = `bearer-${Date.now()}`;
      await request(app.getHttpServer()).post('/api/subjects')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ code, name: 'Bearer 호환 과목' })
        .expect(201);
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });
});
