import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

type ForbiddenCall = {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
};

describe('System, append-only, reference, and derived CRUD boundaries (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
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

  it.each(forbidden)('$method $path has no direct table CRUD route', async ({ method, path }) => {
    await http[method](path).send({ value: 'forbidden' }).expect(404);
  });
});
