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

// [TBO-29C C5] 실 DB 스모크 자격증명 — CEO 실계정 전환(admin 비밀번호 교체·운영 demo 차단) 이후
//  하드코딩 demo1234는 로컬/시드 DB 전용이다. 실 Neon 게이트는 SMOKE_ADMIN_PASSWORD(admin)·
//  SMOKE_STAFF_PASSWORD(그 외 QA 계정)로 주입한다. 비밀번호는 로그/출력에 기록하지 않는다.
const smokePassword = (webId: string): string =>
  webId === 'admin'
    ? process.env.SMOKE_ADMIN_PASSWORD ?? process.env.SMOKE_STAFF_PASSWORD ?? 'demo1234'
    : process.env.SMOKE_STAFF_PASSWORD ?? 'demo1234';

async function login(http: ReturnType<typeof request>, webId: string): Promise<string> {
  const res = await http.post('/api/auth/login').send({ webId, password: smokePassword(webId) }).expect(201);
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
