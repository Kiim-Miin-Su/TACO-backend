import { INestApplication } from '@nestjs/common';
import type { AuditLog } from '@kms545487/contracts';
import request from 'supertest';
import { AUDIT_LOG } from '../src/modules/audit/audit.service';
import { BaseRow, InMemoryDatabase } from '../src/database/in-memory.database';
import { ClassSession, SESSIONS } from '../src/modules/schedule/schedule.entity';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { seedQaPendingPayoutFixture } from './fixtures/seed-qa-payout-fixture';

describe('[TBO-74A] editable payout QA fixture (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminToken = '';
  let managerToken = '';
  let instructorToken = '';

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    adminToken = (
      await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)
    ).body.accessToken;
    managerToken = (
      await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201)
    ).body.accessToken;
    instructorToken = (
      await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)
    ).body.accessToken;
  });
  afterAll(async () => app.close());

  it('creates a pending payout through command services with reverse references and audit', async () => {
    const fixture = await seedQaPendingPayoutFixture(app);
    expect(fixture.payout).toMatchObject({
      instructorId: 1,
      status: 'pending',
      computedAmount: 100_000,
      amount: 100_000,
      sessionCount: 2,
    });
    expect(fixture.payout.lines.map((line) => line.sessionId).sort()).toEqual([20, 22]);
    expect(fixture.payout.lines.reduce((sum, line) => sum + line.amount, 0)).toBe(100_000);
    expect(fixture.auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: 'instructor_payouts',
          entityId: fixture.payout.id,
          action: 'create',
          actorId: 3,
        }),
      ]),
    );

    const db = app.get(InMemoryDatabase);
    for (const sessionId of fixture.sessionIds) {
      expect(db.findById<ClassSession>(SESSIONS, sessionId)?.payoutId).toBe(fixture.payout.id);
    }
  });

  it('requires sudo for final amount adjustment and persists expected/after plus audit', async () => {
    const fixture = await seedQaPendingPayoutFixture(app);
    const endpoint = `/api/payouts/${fixture.payout.id}/adjust`;
    for (const token of [managerToken, instructorToken]) {
      await http
        .post(endpoint)
        .set(sudoAuthHeaders(app, token))
        .send({ amount: 110_000, reason: '권한 없는 최종액 변경' })
        .expect(403);
    }
    await http
      .post(endpoint)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 110_000, reason: 'QA 최종액 변경 검증' })
      .expect(403)
      .then((response) => expect(response.body.code).toBe('SUDO_REQUIRED'));

    const adjusted = (
      await http
        .post(endpoint)
        .set(sudoAuthHeaders(app, adminToken))
        .send({ amount: 110_000, reason: 'QA 최종액 변경 검증' })
        .expect(201)
    ).body;
    expect(adjusted).toMatchObject({
      id: fixture.payout.id,
      computedAmount: 100_000,
      adjustedAmount: 110_000,
      amount: 110_000,
      adjustReason: 'QA 최종액 변경 검증',
    });

    const audits = app.get(InMemoryDatabase).findBy<AuditLog & BaseRow>(
      AUDIT_LOG,
      (row) => row.entity === 'instructor_payouts' && row.entityId === fixture.payout.id,
    );
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'update',
          actorId: 3,
          reason: 'QA 최종액 변경 검증',
          changes: expect.objectContaining({
            amount: { before: 100_000, after: 110_000 },
          }),
        }),
      ]),
    );
  });
});
