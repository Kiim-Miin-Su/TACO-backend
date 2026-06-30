import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 권한 매트릭스 e2e (#6) — 데모 역할별 토큰으로 주요 엔드포인트 호출 → 기대 응답 검증.
// 현재 가드: /auth/pending·approve·reject 만 super_admin 전용. 나머지(schedule·payouts·reports)는
// 아직 역할 가드가 없어 "로그인 누구나 접근 가능"(향후 RolesGuard 확장 대상)임을 이 테스트가 명시한다.
describe('Permission matrix (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => { await app.close(); });

  // 데모 시드 계정(비번 demo1234)
  const ACCOUNTS: Record<string, string> = { super_admin: 'admin', manager: 'manager', instructor: 'park_inst' };
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    for (const [role, webId] of Object.entries(ACCOUNTS)) {
      const res = await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201);
      tokens[role] = res.body.accessToken;
    }
  });

  const auth = (role?: string) => (role ? { Authorization: `Bearer ${tokens[role]}` } : {});

  describe('super_admin 전용 — /auth/pending', () => {
    it('super_admin → 200', async () => {
      await http.get('/api/auth/pending').set(auth('super_admin')).expect(200);
    });
    it('manager → 403', async () => {
      await http.get('/api/auth/pending').set(auth('manager')).expect(403);
    });
    it('instructor → 403', async () => {
      await http.get('/api/auth/pending').set(auth('instructor')).expect(403);
    });
    it('토큰 없음 → 401', async () => {
      await http.get('/api/auth/pending').expect(401);
    });
  });

  describe('super_admin 전용 — /auth/approve/:id (가드가 핸들러보다 먼저)', () => {
    it('manager → 403 (id 무관)', async () => {
      await http.post('/api/auth/approve/999').set(auth('manager')).send({}).expect(403);
    });
    it('토큰 없음 → 401', async () => {
      await http.post('/api/auth/approve/999').send({}).expect(401);
    });
  });

  describe('현재 역할 가드 없음(개방) — 모든 로그인 역할 200 (RolesGuard 확장 대상)', () => {
    const open = ['/api/schedule', '/api/payouts', '/api/reports', '/api/schedule/resources'];
    for (const role of Object.keys(ACCOUNTS)) {
      for (const path of open) {
        it(`${role} → GET ${path} 200`, async () => {
          await http.get(path).set(auth(role)).expect(200);
        });
      }
    }
  });
});
