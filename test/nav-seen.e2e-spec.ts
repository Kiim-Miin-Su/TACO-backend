// [B3 2026-07-16] 알림 뱃지 읽음(last-seen) — upsert·본인 격리·키 검증.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Nav seen states (e2e, B3)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => { await app.close(); });

  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;

  it('마킹(upsert) → 조회 반영, 재마킹 시 시각 전진', async () => {
    const admin = await login('admin');
    const before = (await http.get('/api/nav-seen').set('Authorization', `Bearer ${admin}`).expect(200)).body;
    const first = (await http.put('/api/nav-seen').set('Authorization', `Bearer ${admin}`).send({ navKey: 'admin' }).expect(200)).body;
    expect(first.navKey).toBe('admin');
    if (before.admin) expect(Date.parse(first.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(before.admin));
    const map1 = (await http.get('/api/nav-seen').set('Authorization', `Bearer ${admin}`).expect(200)).body;
    expect(map1.admin).toBe(first.lastSeenAt);
    await new Promise((r) => setTimeout(r, 5));
    const second = (await http.put('/api/nav-seen').set('Authorization', `Bearer ${admin}`).send({ navKey: 'admin' }).expect(200)).body;
    expect(Date.parse(second.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(first.lastSeenAt));
    const map2 = (await http.get('/api/nav-seen').set('Authorization', `Bearer ${admin}`).expect(200)).body;
    expect(Object.keys(map2).filter((key) => key === 'admin')).toHaveLength(1); // upsert — 해당 키 행 1개 유지
  });

  it('동시 마킹도 unique 충돌 없이 모두 성공하고 활성 행은 한 건이다', async () => {
    const admin = await login('admin');
    const calls = await Promise.all([
      http.put('/api/nav-seen').set('Authorization', `Bearer ${admin}`).send({ navKey: 'calendar' }),
      http.put('/api/nav-seen').set('Authorization', `Bearer ${admin}`).send({ navKey: 'calendar' }),
    ]);
    expect(calls.map((response) => response.status)).toEqual([200, 200]);
    const mine = (await http.get('/api/nav-seen').set('Authorization', `Bearer ${admin}`).expect(200)).body;
    expect(Object.keys(mine).filter((key) => key === 'calendar')).toHaveLength(1);
  });

  it('본인 격리 — 다른 계정의 열람이 내 맵에 섞이지 않는다', async () => {
    const manager = await login('manager');
    await http.put('/api/nav-seen').set('Authorization', `Bearer ${manager}`).send({ navKey: 'payments' }).expect(200);
    const managerMap = (await http.get('/api/nav-seen').set('Authorization', `Bearer ${manager}`).expect(200)).body;
    expect(managerMap.payments).toBeTruthy();
    expect(managerMap.admin).toBeUndefined(); // admin 계정의 마킹은 안 보임
  });

  it('허용 키 밖 400 · 비로그인 401', async () => {
    const admin = await login('admin');
    await http.put('/api/nav-seen').set('Authorization', `Bearer ${admin}`).send({ navKey: 'hack' }).expect(400);
    await http.get('/api/nav-seen').expect(401);
    await http.put('/api/nav-seen').send({ navKey: 'admin' }).expect(401);
  });
});
