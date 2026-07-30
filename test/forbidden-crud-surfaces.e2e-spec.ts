// [TBO-79 F3] 종전엔 system·append-only·reference·derived 10표만 확인했다. `verify-crud-surfaces`가
//  `aggregate-child`로 분류한 8표(부모 aggregate command만 소유해야 하는 표)는 "직접 CRUD가 없다"는
//  주장에 증거가 전혀 없었다 — TBO-77 E-7이 조기에 닫힌 자리다(거짓 완료 FC-3).
//  또한 익명 404만 보면 "라우트는 없지만 인증된 관리자에게는 열려 있다"를 놓치므로, 인증 케이스도 본다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';

type ForbiddenCall = {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
};

describe('System, append-only, reference, and derived CRUD boundaries (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminToken = '';

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    adminToken = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201))
      .body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const forbidden: ForbiddenCall[] = [
    { method: 'post', path: '/api/transactions' },
    { method: 'patch', path: '/api/transactions/1' },
    { method: 'delete', path: '/api/transactions/1' },
    { method: 'post', path: '/api/audit' },
    { method: 'patch', path: '/api/audit/1' },
    { method: 'delete', path: '/api/audit/1' },
    { method: 'post', path: '/api/auth/events' },
    { method: 'patch', path: '/api/auth/events/1' },
    { method: 'delete', path: '/api/auth/events/1' },
    { method: 'post', path: '/api/catalog/countries' },
    { method: 'patch', path: '/api/catalog/countries/1' },
    { method: 'delete', path: '/api/catalog/countries/1' },
    { method: 'get', path: '/api/schema-migrations' },
    { method: 'get', path: '/api/auth/refresh-tokens' },
    { method: 'get', path: '/api/auth/rate-limits' },
    { method: 'get', path: '/api/profile-verification-challenges' },
    { method: 'get', path: '/api/auth/signup-email-challenges' },
    { method: 'get', path: '/api/auth/signup-phone-challenges' },
  ];

  // [TBO-79 F3] aggregate-child 8표 — 부모 aggregate command만 lifecycle을 소유해야 한다.
  //  직접 표 이름으로 뚫린 CRUD 라우트가 없음을 증명한다(있으면 부모의 무결성 가드를 우회한다).
  const aggregateChildForbidden: ForbiddenCall[] = [
    { method: 'get', path: '/api/student-interests' },
    { method: 'post', path: '/api/student-interests' },
    { method: 'patch', path: '/api/student-interests/1' },
    { method: 'delete', path: '/api/student-interests/1' },
    { method: 'get', path: '/api/student-academic-histories' },
    { method: 'post', path: '/api/student-academic-histories' },
    { method: 'delete', path: '/api/student-academic-histories/1' },
    { method: 'get', path: '/api/parent-student-relations' },
    { method: 'post', path: '/api/parent-student-relations' },
    { method: 'delete', path: '/api/parent-student-relations/1' },
    { method: 'get', path: '/api/student-family-relations' },
    { method: 'post', path: '/api/student-family-relations' },
    { method: 'delete', path: '/api/student-family-relations/1' },
    { method: 'get', path: '/api/roadmap-courses' },
    { method: 'post', path: '/api/roadmap-courses' },
    { method: 'delete', path: '/api/roadmap-courses/1' },
    { method: 'get', path: '/api/counsel-rounds' },
    { method: 'post', path: '/api/counsel-rounds' },
    { method: 'patch', path: '/api/counsel-rounds/1' },
    { method: 'get', path: '/api/class-session-series' },
    { method: 'post', path: '/api/class-session-series' },
    { method: 'patch', path: '/api/schedule/series/1' },
    { method: 'delete', path: '/api/schedule/series/1' },
    { method: 'get', path: '/api/instructor-profiles' },
    { method: 'post', path: '/api/instructor-profiles' },
    { method: 'patch', path: '/api/instructor-profiles/1' },
  ];

  // derived — 서버 계산 결과라 직접 쓰기가 없어야 한다.
  const derivedForbidden: ForbiddenCall[] = [
    { method: 'patch', path: '/api/payouts/1' },
    { method: 'delete', path: '/api/payouts/1' },
    { method: 'post', path: '/api/payouts/1/lines' },
    { method: 'patch', path: '/api/enrollments/1/completed-sessions' },
    { method: 'post', path: '/api/attendance' },
    { method: 'delete', path: '/api/enrollments/1' },
  ];

  it.each(forbidden)('$method $path has no direct table CRUD route', async ({ method, path }) => {
    await http[method](path).send({ value: 'forbidden' }).expect(404);
  });

  it.each([...aggregateChildForbidden, ...derivedForbidden])(
    '$method $path is absent for an authenticated admin too',
    async ({ method, path }) => {
      // 익명 404는 "인증이 없어서"일 수도 있다. 최고 권한으로도 라우트가 없어야 진짜 부재다.
      await http[method](path)
        .set(sudoAuthHeaders(app, adminToken))
        .send({ value: 'forbidden' })
        .expect(404);
    },
  );

  // [TBO-79 F3] 세션 삭제는 되돌릴 수 없다 — restore는 의도적으로 항상 409다(조용한 성공 금지).
  it('POST /api/schedule/:id/restore 는 항상 409로 거부한다', async () => {
    const res = await http.post('/api/schedule/1/restore').set(sudoAuthHeaders(app, adminToken)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SESSION_AGGREGATE_RESTORE_REQUIRED');
  });
});
