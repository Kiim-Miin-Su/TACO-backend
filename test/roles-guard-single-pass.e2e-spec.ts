import type { INestApplication } from '@nestjs/common';
import request, { type SuperTest, type Test } from 'supertest';
import { RolesGuard } from '../src/modules/auth/roles.guard';
import { createTestApp } from './setup-app';

describe('global RolesGuard single-pass boundary (e2e)', () => {
  let app: INestApplication;
  let http: SuperTest<Test>;
  let adminToken: string;
  let guardSpy: jest.SpyInstance;

  beforeAll(async () => {
    guardSpy = jest.spyOn(RolesGuard.prototype, 'canActivate');
    app = await createTestApp();
    http = request(app.getHttpServer());
    const login = await http
      .post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);
    adminToken = login.body.accessToken as string;
  });

  beforeEach(() => guardSpy.mockClear());

  afterAll(async () => {
    guardSpy.mockRestore();
    await app.close();
  });

  it('runs exactly once for an authorized protected request', async () => {
    await http
      .get('/api/subjects')
      .set({ Authorization: `Bearer ${adminToken}` })
      .expect(200);

    expect(guardSpy).toHaveBeenCalledTimes(1);
  });

  it('runs exactly once before rejecting an unauthenticated request', async () => {
    await http.get('/api/subjects').expect(401);

    expect(guardSpy).toHaveBeenCalledTimes(1);
  });
});
