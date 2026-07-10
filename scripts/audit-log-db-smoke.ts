import 'reflect-metadata';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

type AuditRow = {
  id: number;
  entity: string;
  entityId: number;
  action: string;
  actorId: number;
  changes?: Record<string, unknown>;
  reason?: string;
};

async function login(http: ReturnType<typeof request>, webId: string): Promise<string> {
  const res = await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201);
  return res.body.accessToken;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function requireEnv(): void {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for audit DB smoke');
  }
}

async function main(): Promise<void> {
  requireEnv();

  const stamp = Date.now();
  const day = String((stamp % 20) + 1).padStart(2, '0');
  const effectiveDate = `2099-09-${day}`;
  let availabilityId = 0;

  {
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');

    const created = await http.put('/api/availability')
      .set(auth(manager))
      .send({
        ownerType: 'student',
        ownerId: 2,
        kind: 'available',
        weekday: 0,
        startTime: '06:00',
        endTime: '06:30',
        effectiveFrom: effectiveDate,
        effectiveTo: effectiveDate,
      })
      .expect(200);
    availabilityId = created.body.id;

    const audit = (await http.get(`/api/audit?entity=availability_blocks&entityId=${availabilityId}`)
      .set(auth(manager))
      .expect(200)).body as AuditRow[];
    if (!audit.some((row) => row.action === 'create' && row.actorId === 4 && row.changes?.__row)) {
      throw new Error(`create audit for availability ${availabilityId} was not visible before restart`);
    }
    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');

    const audit = (await http.get(`/api/audit?entity=availability_blocks&entityId=${availabilityId}`)
      .set(auth(manager))
      .expect(200)).body as AuditRow[];
    if (!audit.some((row) => row.action === 'create' && row.actorId === 4 && row.changes?.__row)) {
      throw new Error(`create audit for availability ${availabilityId} did not survive restart`);
    }

    await http.delete(`/api/availability/${availabilityId}`).set(auth(manager)).expect(200);
    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');

    const audit = (await http.get(`/api/audit?entity=availability_blocks&entityId=${availabilityId}`)
      .set(auth(manager))
      .expect(200)).body as AuditRow[];
    if (!audit.some((row) => row.action === 'delete' && row.actorId === 4 && row.changes?.__row)) {
      throw new Error(`delete audit for availability ${availabilityId} did not survive restart`);
    }
    await app.close();
  }

  console.log(JSON.stringify({ ok: true, availabilityId, effectiveDate }));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
