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

  describe('읽기(GET)는 개방 — 모든 로그인 역할 200', () => {
    const open = ['/api/schedule', '/api/payouts', '/api/reports', '/api/schedule/resources'];
    for (const role of Object.keys(ACCOUNTS)) {
      for (const path of open) {
        it(`${role} → GET ${path} 200`, async () => {
          await http.get(path).set(auth(role)).expect(200);
        });
      }
    }
  });

  // 백오피스 쓰기 액션은 RolesGuard(super_admin/manager/admin) 전용.
  // 가드가 핸들러보다 먼저 실행되므로 id가 유효하지 않아도 인가 결과(403/401)가 먼저 나온다.
  describe('RolesGuard — 관리자 전용 쓰기 액션 거부', () => {
    const adminWrites = ['/api/payouts/999/confirm', '/api/reports/999/approve', '/api/expenses/999/approve'];
    for (const path of adminWrites) {
      it(`instructor → POST ${path} 403`, async () => {
        await http.post(path).set(auth('instructor')).send({}).expect(403);
      });
      it(`토큰 없음 → POST ${path} 401`, async () => {
        await http.post(path).send({}).expect(401);
      });
      it(`manager → POST ${path} 통과(가드 허용, 403/401 아님)`, async () => {
        const res = await http.post(path).set(auth('manager')).send({});
        expect([401, 403]).not.toContain(res.status); // 인가 통과 → 이후 핸들러 결과(예: 404/400)
      });
    }
  });
});
