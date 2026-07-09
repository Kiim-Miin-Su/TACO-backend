import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Health DB connection (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const oldDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    app = await createTestApp();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    if (oldDatabaseUrl) process.env.DATABASE_URL = oldDatabaseUrl;
    else delete process.env.DATABASE_URL;
    await app.close();
  });

  it('reports in-memory runtime when DATABASE_URL is not configured', async () => {
    const res = await http.get('/api/health/db').expect(200);

    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'taco-api',
      db: {
        runtimeStore: 'in-memory',
        configured: false,
        ready: false,
      },
    });
    expect(res.body.db.host).toBeUndefined();
  });
});
