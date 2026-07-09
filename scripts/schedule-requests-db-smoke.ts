import 'reflect-metadata';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

type RequestRow = {
  id: number;
  topic?: string;
  status: 'pending' | 'approved' | 'rejected';
  reason?: string;
};

async function login(http: ReturnType<typeof request>, webId: string): Promise<string> {
  const res = await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201);
  return res.body.accessToken;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for DB smoke');
  }

  const stamp = Date.now();
  const minute = String(stamp % 50).padStart(2, '0');
  const topic = `TBO-23-A1A2-db-smoke-${stamp}`;
  const reason = `DB smoke rejected ${stamp}`;
  let createdId = 0;

  {
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    const http = request(app.getHttpServer());
    const instructor = await login(http, 'park_inst');
    const target = ((await http.get('/api/schedule')
      .set({ Authorization: `Bearer ${instructor}` })
      .expect(200)).body as Array<{ id: number; sessionDate: string }>).find((row) => row.id === 1);
    if (!target) throw new Error('seed session 1 was not found for session_update smoke');
    const created = await http.post('/api/schedule-requests')
      .set({ Authorization: `Bearer ${instructor}` })
      .send({
        requestKind: 'session_update',
        targetSessionId: target.id,
        sessionDate: target.sessionDate,
        startTime: `07:${minute}`,
        endTime: `08:${minute}`,
        topic,
        requestReason: 'A1/A2 DB persistence smoke',
        scope: 'this',
        kind: 'class',
        mode: 'online',
      })
      .expect(201);
    createdId = created.body.row.id;
    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');
    const ceo = await login(http, 'admin');

    const pending = (await http.get('/api/schedule-requests?status=pending')
      .set({ Authorization: `Bearer ${manager}` })
      .expect(200)).body as RequestRow[];
    if (!pending.some((row) => row.id === createdId && row.topic === topic)) {
      throw new Error(`created request ${createdId} was not visible to manager after app restart`);
    }

    await http.post(`/api/schedule-requests/${createdId}/reject`)
      .set({ Authorization: `Bearer ${manager}` })
      .send({ reason })
      .expect(201);

    const ceoPending = (await http.get('/api/schedule-requests?status=pending')
      .set({ Authorization: `Bearer ${ceo}` })
      .expect(200)).body as RequestRow[];
    if (ceoPending.some((row) => row.id === createdId)) {
      throw new Error(`processed request ${createdId} is still visible in CEO pending list`);
    }

    const rejected = (await http.get('/api/schedule-requests?status=rejected')
      .set({ Authorization: `Bearer ${ceo}` })
      .expect(200)).body as RequestRow[];
    const row = rejected.find((x) => x.id === createdId);
    if (!row || row.reason !== reason) {
      throw new Error(`rejected request ${createdId} was not persisted with the manager reason`);
    }
    await app.close();
  }

  console.log(JSON.stringify({ ok: true, requestId: createdId, topic }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
