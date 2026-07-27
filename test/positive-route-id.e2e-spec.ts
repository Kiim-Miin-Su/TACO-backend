import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('positive route identifier boundary (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let auth: { Authorization: string };

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const login = await http
      .post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201);
    auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['0', '-1', '01', '1.0', '1.5', '1e3', 'NaN', '2147483648'])(
    'rejects invalid path id %s before the payment service',
    async (candidate) => {
      await http
        .get(`/api/payments/${encodeURIComponent(candidate)}`)
        .set(auth)
        .expect(400);
    },
  );

  it.each(['0', '-1', '01', '1.0', '1.5', '1e3', 'NaN', '2147483648'])(
    'rejects invalid required query id %s before the payout service',
    async (candidate) => {
      await http
        .get('/api/payouts/preview')
        .query({
          instructorId: candidate,
          from: '2026-07-01',
          to: '2026-07-31',
        })
        .set(auth)
        .expect(400);
    },
  );

  it('accepts the maximum PostgreSQL integer and reaches domain lookup', async () => {
    await http.get('/api/payments/2147483647').set(auth).expect(404);
  });

  it.each([
    ['/api/reports', 'sessionId', '01'],
    ['/api/availability', 'ownerId', '1.0'],
    ['/api/counsel/rounds', 'counselFormId', '1e3'],
    ['/api/attendance', 'sessionId', '2147483648'],
    ['/api/enrollments', 'studentId', '0'],
    ['/api/schedule', 'instructorId', '-1'],
    ['/api/schedule', 'roomId', 'NaN'],
    ['/api/schedule', 'studentId', '1.5'],
    ['/api/payouts/readiness', 'instructorId', '01'],
    ['/api/audit', 'entityId', '1.0'],
    ['/api/audit', 'actorId', '1e3'],
  ])(
    'rejects invalid optional query %s?%s=%s',
    async (path, field, candidate) => {
      await http.get(path).query({ [field]: candidate }).set(auth).expect(400);
    },
  );

  it.each([
    ['/api/payouts/uncovered', 'months', '13'],
    ['/api/audit', 'limit', '501'],
  ])(
    'rejects an optional integer outside its business range',
    async (path, field, candidate) => {
      await http.get(path).query({ [field]: candidate }).set(auth).expect(400);
    },
  );

  it('keeps omitted optional filters valid and applies no-store/request-id headers', async () => {
    const response = await http.get('/api/schedule').set(auth).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{4,64}$/);
  });
});
