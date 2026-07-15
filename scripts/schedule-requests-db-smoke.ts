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

// [TBO-29C C5] 실 DB 스모크 자격증명 — CEO 실계정 전환(admin 비밀번호 교체·운영 demo 차단) 이후
//  하드코딩 demo1234는 로컬/시드 DB 전용이다. 실 Neon 게이트는 SMOKE_ADMIN_PASSWORD(admin)·
//  SMOKE_STAFF_PASSWORD(그 외 QA 계정)로 주입한다. 비밀번호는 로그/출력에 기록하지 않는다.
//  [실계정 2026-07-15] admin 첫 로그인 rotation 후에는 webId 자체가 바뀐다 —
//  SMOKE_ADMIN_WEBID로 새 아이디를 주입한다(미설정 시 'admin' — 로컬 시드 전용).
const SMOKE_ADMIN_WEBID = process.env.SMOKE_ADMIN_WEBID ?? 'admin';
const smokePassword = (webId: string): string =>
  webId === SMOKE_ADMIN_WEBID
    ? process.env.SMOKE_ADMIN_PASSWORD ?? process.env.SMOKE_STAFF_PASSWORD ?? 'demo1234'
    : process.env.SMOKE_STAFF_PASSWORD ?? 'demo1234';

async function login(http: ReturnType<typeof request>, webId: string): Promise<string> {
  const res = await http.post('/api/auth/login').send({ webId, password: smokePassword(webId) }).expect(201);
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
    const ceo = await login(http, SMOKE_ADMIN_WEBID);

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
