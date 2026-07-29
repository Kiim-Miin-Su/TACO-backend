// [대표 지시 ④ 2026-07-16] refresh token 회전 규약 e2e —
//  발급(httpOnly 쿠키) → 갱신(회전) → 구 토큰 재사용 차단(가족 무효화+보안 이벤트) →
//  auth_version 변경 시 무효 → 로그아웃 폐기.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { createHash } from 'crypto';

const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const setCookie = ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []);
  const line = setCookie.find((c) => c.startsWith('refresh_token='));
  if (!line) throw new Error('refresh_token Set-Cookie 없음');
  return line.split(';')[0]; // "refresh_token=..."
};
const cookieAttrs = (res: { headers: Record<string, unknown> }): string =>
  (([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []).find((c) => c.startsWith('refresh_token=')) ?? '');

describe('Refresh token rotation (e2e, 대표 지시 ④)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  const login = async (webId = 'manager', password = 'demo1234') =>
    http.post('/api/auth/login').send({ webId, password }).expect(201);

  it('로그인이 httpOnly refresh 쿠키를 발급하고, 저장소에는 hash만 남는다', async () => {
    const res = await login();
    const attrs = cookieAttrs(res);
    expect(attrs).toContain('HttpOnly');
    expect(attrs).toContain('Path=/api/auth');
    const raw = cookieOf(res).split('=')[1];
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    // 원문 미저장 — hash(64 hex)만, 원문과 불일치
    const rows = db.findAll<{ tokenHash: string }>('auth_refresh_tokens');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.tokenHash === raw)).toBe(false);
  });

  it('같은 브라우저의 재로그인은 이전 refresh를 폐기하고 새 계정 token pair만 교체 발급한다', async () => {
    const first = await login('manager', 'demo1234');
    const oldCookie = cookieOf(first);
    const oldRaw = oldCookie.split('=')[1];
    const second = await http.post('/api/auth/login')
      .set('Cookie', oldCookie)
      .send({ webId: 'park_inst', password: 'demo1234' })
      .expect(201);
    const nextCookie = cookieOf(second);
    expect(nextCookie).not.toBe(oldCookie);
    expect(second.body.account).toMatchObject({ role: 'instructor' });

    const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
    const rows = db.findAll<{ tokenHash: string; userId: number; revokedAt?: string | null }>('auth_refresh_tokens');
    expect(rows.find((row) => row.tokenHash === hash(oldRaw))?.revokedAt).toBeTruthy();
    expect(rows.find((row) => row.tokenHash === hash(nextCookie.split('=')[1]))).toMatchObject({
      userId: second.body.account.id,
      revokedAt: null,
    });
    await http.post('/api/auth/refresh').set('Cookie', nextCookie).expect(201);
  });

  it('refresh 회전: 새 access·새 쿠키 발급, 구 토큰 재사용은 401 + 가족 전체 무효 + 보안 이벤트', async () => {
    const first = await login();
    const cookie1 = cookieOf(first);

    // 1차 갱신 — 새 access token이 실제로 유효(GET /auth/me 200), 쿠키 회전
    const r1 = await http.post('/api/auth/refresh').set('Cookie', cookie1).expect(201);
    expect(r1.body.accessToken).toBeTruthy();
    expect(r1.body.account).toMatchObject({ role: 'manager' });
    await http.get('/api/auth/me').set('Authorization', `Bearer ${r1.body.accessToken}`).expect(200);
    const cookie2 = cookieOf(r1);
    expect(cookie2).not.toBe(cookie1);

    // 구 쿠키 재사용(탈취 시나리오) → 401 + 사용자 전 refresh 무효(새 쿠키도 죽는다) + 이벤트 기록
    await http.post('/api/auth/refresh').set('Cookie', cookie1).expect(401);
    await http.post('/api/auth/refresh').set('Cookie', cookie2).expect(401);
    const events = db.findAll<{ eventType: string; failureCode?: string }>('auth_events')
      .filter((e) => e.eventType === 'refresh_reuse_blocked');
    expect(events.length).toBeGreaterThan(0);
  });

  it('같은 refresh 동시 회전은 successor 하나만 만들고 재사용 감지로 family를 폐기한다', async () => {
    const first = await login('manager', 'demo1234');
    const cookie = cookieOf(first);
    const hash = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    const predecessor = db.findAll<{ id: number; tokenHash: string }>('auth_refresh_tokens')
      .find((row) => row.tokenHash === hash)!;

    const [a, b] = await Promise.all([
      http.post('/api/auth/refresh').set('Cookie', cookie),
      http.post('/api/auth/refresh').set('Cookie', cookie),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 401]);
    const rows = db.findAll<{ id: number; replacedById?: number | null; revokedAt?: string | null }>('auth_refresh_tokens');
    const linked = rows.filter((row) => row.id === predecessor.id && row.replacedById != null);
    expect(linked).toHaveLength(1);
    const successor = rows.find((row) => row.id === linked[0].replacedById);
    expect(successor?.revokedAt).toBeTruthy();
  });

  it('auth_version 변경(비밀번호 변경 계열) 후의 refresh는 401 — 발급 시점 버전 동결 대조', async () => {
    const res = await login('park_inst', 'demo1234');
    const cookie = cookieOf(res);
    // 계정 auth_version 인위 증가(비밀번호/아이디 변경과 동일 효과) — [PG 이중 세팅 규약 §13.83]
    //  refresh 경로가 refreshFromDb로 권위(PG)를 재수화하므로 메모리만 갱신하면 되돌아간다.
    const acc = db.findAll<{ id: number; webId: string; authVersion?: number }>('users').find((u) => u.webId === 'park_inst')!;
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) await pg.query('UPDATE users SET auth_version = COALESCE(auth_version, 1) + 1 WHERE id = $1', [acc.id]);
    db.update('users', acc.id, { authVersion: (acc.authVersion ?? 1) + 1 } as never);
    await http.post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('로그아웃은 제시된 refresh를 폐기하고 쿠키를 지운다 — 이후 갱신 401', async () => {
    const res = await login('prof_admin', 'demo1234');
    const cookie = cookieOf(res);
    const out = await http.post('/api/auth/logout').set('Cookie', cookie)
      .set('Authorization', `Bearer ${res.body.accessToken}`).expect(201);
    expect(cookieAttrs(out)).toContain('refresh_token=;'); // 클리어(Max-Age=0)
    await http.post('/api/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('쿠키 없는 갱신 요청은 401', async () => {
    await http.post('/api/auth/refresh').expect(401);
  });
});
