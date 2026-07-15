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
  requestReason?: string;
};

type ScheduleRow = {
  id: number;
  courseId: number;
  instructorId: number;
  sessionDate: string;
  startTime?: string;
  endTime?: string;
  topic?: string;
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
    throw new Error('DATABASE_URL/POSTGRES_URL is required for DB approval smoke');
  }
}

async function main(): Promise<void> {
  requireEnv();

  const stamp = Date.now();
  const day = String((stamp % 20) + 1).padStart(2, '0');
  const smokeDate = `2099-07-${day}`;
  const safeStart = '14:05';
  const safeEnd = '14:55';
  const conflictStart = '15:45';
  const conflictEnd = '16:15';
  const targetTopic = `TBO-24-24C-target-${stamp}`;
  const conflictTopic = `TBO-24-24C-conflict-${stamp}`;
  const safeTopic = `TBO-24-24C-approved-${stamp}`;
  const blockerTopic = `TBO-24-24C-blocker-${stamp}`;
  const rejectReason = `24C conflict reject ${stamp}`;
  let conflictId = 0;
  let safeId = 0;
  let targetId = 0;
  let blockerId = 0;
  let targetDate = '';

  {
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    const http = request(app.getHttpServer());
    const instructor = await login(http, 'park_inst');
    const manager = await login(http, 'manager');
    const target = await http.post('/api/schedule')
      .set(auth(manager))
      .send({
        courseId: 10,
        instructorId: 1,
        roomId: 1,
        sessionDate: smokeDate,
        startTime: '09:00',
        endTime: '10:00',
        topic: targetTopic,
        kind: 'class',
        mode: 'online',
        force: true,
      })
      .expect(201);
    targetId = target.body.row.id;
    targetDate = smokeDate;

    const blocker = await http.post('/api/schedule')
      .set(auth(manager))
      .send({
        courseId: 10,
        instructorId: 1,
        roomId: 2,
        sessionDate: smokeDate,
        startTime: '15:30',
        endTime: '16:30',
        topic: blockerTopic,
        kind: 'class',
        mode: 'online',
        force: true,
      })
      .expect(201);
    blockerId = blocker.body.row.id;

    const conflict = await http.post('/api/schedule-requests')
      .set(auth(instructor))
      .send({
        requestKind: 'session_update',
        targetSessionId: targetId,
        sessionDate: smokeDate,
        startTime: conflictStart,
        endTime: conflictEnd,
        topic: conflictTopic,
        requestReason: '24C smoke: conflict should remain pending until rejected',
        scope: 'this',
        kind: 'class',
        mode: 'online',
      })
      .expect(201);
    conflictId = conflict.body.row.id;

    const safe = await http.post('/api/schedule-requests')
      .set(auth(instructor))
      .send({
        requestKind: 'session_update',
        targetSessionId: targetId,
        sessionDate: smokeDate,
        startTime: safeStart,
        endTime: safeEnd,
        topic: safeTopic,
        requestReason: '24C smoke: approved change must persist in class_sessions',
        scope: 'this',
        kind: 'class',
        mode: 'online',
      })
      .expect(201);
    safeId = safe.body.row.id;
    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');
    const scheduleBeforeDecision = (await http.get(`/api/schedule?from=${targetDate}&to=${targetDate}`)
      .set(auth(manager))
      .expect(200)).body as ScheduleRow[];
    const hydratedBlocker = scheduleBeforeDecision.find((row) => row.id === blockerId);
    if (!hydratedBlocker || hydratedBlocker.startTime !== '15:30' || hydratedBlocker.endTime !== '16:30') {
      throw new Error(`blocker ${blockerId} was not hydrated before approval on ${targetDate}: ${JSON.stringify({
        hydratedBlocker,
        rows: scheduleBeforeDecision.map((row) => ({ id: row.id, startTime: row.startTime, endTime: row.endTime, topic: row.topic })),
      })}`);
    }
    const hydratedTarget = scheduleBeforeDecision.find((row) => row.id === targetId);
    if (!hydratedTarget) {
      throw new Error(`target ${targetId} was not hydrated before approval`);
    }

    const pending = (await http.get('/api/schedule-requests?status=pending')
      .set(auth(manager))
      .expect(200)).body as RequestRow[];
    if (!pending.some((row) => row.id === conflictId && row.topic === conflictTopic)) {
      throw new Error(`conflict request ${conflictId} was not visible to manager after restart`);
    }
    if (!pending.some((row) => row.id === safeId && row.topic === safeTopic)) {
      throw new Error(`safe request ${safeId} was not visible to manager after restart`);
    }

    await http.post(`/api/schedule-requests/${conflictId}/approve`)
      .set(auth(manager))
      .expect(409);
    const stillPending = (await http.get('/api/schedule-requests?status=pending')
      .set(auth(manager))
      .expect(200)).body as RequestRow[];
    if (!stillPending.some((row) => row.id === conflictId)) {
      throw new Error(`conflict request ${conflictId} did not remain pending after failed approval`);
    }

    await http.post(`/api/schedule-requests/${conflictId}/reject`)
      .set(auth(manager))
      .send({ reason: rejectReason })
      .expect(201);

    const approvalAttempts = await Promise.all([
      http.post(`/api/schedule-requests/${safeId}/approve`).set(auth(manager)),
      http.post(`/api/schedule-requests/${safeId}/approve`).set(auth(manager)),
    ]);
    const approvalStatuses = approvalAttempts.map((response) => response.status).sort();
    if (approvalStatuses[0] !== 201 || approvalStatuses[1] !== 400) {
      throw new Error(`concurrent approval statuses were not 201/400: ${approvalStatuses.join(',')}`);
    }
    const approved = approvalAttempts.find((response) => response.status === 201);
    if (!approved) throw new Error(`safe request ${safeId} had no successful approval`);
    if (approved.body.request.status !== 'approved') {
      throw new Error(`safe request ${safeId} was not approved: ${JSON.stringify(approved.body)}`);
    }

    const changed = ((await http.get('/api/schedule')
      .set(auth(manager))
      .expect(200)).body as ScheduleRow[]).find((row) => row.id === targetId);
    if (!changed || changed.startTime !== safeStart || changed.endTime !== safeEnd || changed.topic !== safeTopic) {
      throw new Error(`approved session update was not visible before restart for target ${targetId}`);
    }
    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const ceo = await login(http, 'admin');

    const ceoPending = (await http.get('/api/schedule-requests?status=pending')
      .set(auth(ceo))
      .expect(200)).body as RequestRow[];
    if (ceoPending.some((row) => row.id === conflictId || row.id === safeId)) {
      throw new Error('processed requests are still visible in CEO pending list');
    }

    const rejected = (await http.get('/api/schedule-requests?status=rejected')
      .set(auth(ceo))
      .expect(200)).body as RequestRow[];
    if (rejected.find((row) => row.id === conflictId)?.reason !== rejectReason) {
      throw new Error(`rejected reason for ${conflictId} was not persisted`);
    }

    const approved = (await http.get('/api/schedule-requests?status=approved')
      .set(auth(ceo))
      .expect(200)).body as RequestRow[];
    if (!approved.some((row) => row.id === safeId && row.topic === safeTopic)) {
      throw new Error(`approved request ${safeId} was not persisted`);
    }

    const changed = ((await http.get(`/api/schedule?from=${targetDate}&to=${targetDate}`)
      .set(auth(ceo))
      .expect(200)).body as ScheduleRow[]).find((row) => row.id === targetId);
    if (!changed || changed.startTime !== safeStart || changed.endTime !== safeEnd || changed.topic !== safeTopic) {
      throw new Error(`approved class_sessions update for target ${targetId} did not survive restart`);
    }
    await app.close();
  }

  console.log(JSON.stringify({
    ok: true,
    targetId,
    targetDate,
    conflictRequestId: conflictId,
    approvedRequestId: safeId,
    approvedStart: safeStart,
    approvedEnd: safeEnd,
  }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
