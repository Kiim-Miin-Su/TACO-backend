import 'reflect-metadata';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

type AvailabilityRow = {
  id: number;
  ownerType: string;
  ownerId: number;
  kind: string;
  weekday: number;
  startTime: string;
  endTime: string;
  deletedAt?: string | null;
};

type PresetRow = {
  id: number;
  name: string;
  view: string;
  instructorIds: number[];
  studentIds: number[];
  roomIds: number[];
  manualPanes?: Array<Record<string, unknown>>;
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
    throw new Error('DATABASE_URL/POSTGRES_URL is required for DB asset smoke');
  }
}

async function main(): Promise<void> {
  requireEnv();

  const stamp = Date.now();
  const presetName = `TBO-24-assets-${stamp}`;
  let availabilityId = 0;
  let presetId = 0;

  {
    console.log('[asset-smoke] boot app #1');
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    const http = request(app.getHttpServer());
    console.log('[asset-smoke] login manager #1');
    const manager = await login(http, 'manager');

    console.log('[asset-smoke] read reference data');
    const users = await http.get('/api/users').set(auth(manager)).expect(200);
    const students = await http.get('/api/students').set(auth(manager)).expect(200);
    const subjects = await http.get('/api/subjects').set(auth(manager)).expect(200);
    const courses = await http.get('/api/courses').set(auth(manager)).expect(200);
    const rooms = await http.get('/api/rooms').set(auth(manager)).expect(200);
    const enrollments = await http.get('/api/enrollments').set(auth(manager)).expect(200);
    if (users.body.length < 4 || students.body.length < 4 || subjects.body.length < 2 || courses.body.length < 3 || rooms.body.length < 3 || enrollments.body.length < 4) {
      throw new Error(`reference seed hydration failed: ${JSON.stringify({
        users: users.body.length,
        students: students.body.length,
        subjects: subjects.body.length,
        courses: courses.body.length,
        rooms: rooms.body.length,
        enrollments: enrollments.body.length,
      })}`);
    }

    console.log('[asset-smoke] create availability');
    const availability = await http.put('/api/availability')
      .set(auth(manager))
      .send({
        ownerType: 'student',
        ownerId: 1,
        kind: 'online_only',
        weekday: 6,
        startTime: '08:00',
        endTime: '08:30',
        effectiveFrom: '2099-08-01',
        effectiveTo: '2099-08-31',
      })
      .expect(200);
    availabilityId = availability.body.id;

    console.log('[asset-smoke] create view preset');
    const preset = await http.post('/api/view-presets')
      .set(auth(manager))
      .send({
        name: presetName,
        view: 'week',
        periodFrom: '2099-08-01',
        periodTo: '2099-08-07',
        instructorIds: [1],
        studentIds: [1],
        roomIds: [1],
        subjects: ['english'],
        statuses: [],
        groupOnly: false,
        colorBy: 'instructor',
        countryCode: 'KR',
        modeFilters: ['online'],
        kstFixed: true,
        compactCols: true,
        manualPanes: [{ uid: 1, dim: 'instructor', ids: [1], countryCode: 'KR', modeFilters: ['online'] }],
      })
      .expect(201);
    presetId = preset.body.id;
    await app.close();
  }

  {
    console.log('[asset-smoke] boot app #2');
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    console.log('[asset-smoke] login manager #2');
    const manager = await login(http, 'manager');

    console.log('[asset-smoke] verify persisted availability/preset');
    const availabilityRows = (await http.get('/api/availability?ownerType=student&ownerId=1')
      .set(auth(manager))
      .expect(200)).body as AvailabilityRow[];
    const availability = availabilityRows.find((row) => row.id === availabilityId);
    if (!availability || availability.kind !== 'online_only' || availability.startTime !== '08:00' || availability.endTime !== '08:30') {
      throw new Error(`availability ${availabilityId} did not survive restart`);
    }

    const presets = (await http.get('/api/view-presets')
      .set(auth(manager))
      .expect(200)).body as PresetRow[];
    const preset = presets.find((row) => row.id === presetId);
    if (!preset || preset.name !== presetName || preset.manualPanes?.[0]?.dim !== 'instructor') {
      throw new Error(`view preset ${presetId} did not survive restart`);
    }

    console.log('[asset-smoke] update availability');
    await http.put('/api/availability')
      .set(auth(manager))
      .send({
        id: availabilityId,
        ownerType: 'student',
        ownerId: 1,
        kind: 'unavailable',
        weekday: 6,
        startTime: '08:30',
        endTime: '09:00',
        effectiveFrom: '2099-08-01',
        effectiveTo: '2099-08-31',
      })
      .expect(200);

    console.log('[asset-smoke] update view preset');
    await http.patch(`/api/view-presets/${presetId}`)
      .set(auth(manager))
      .send({
        name: presetName,
        view: 'day',
        periodFrom: '2099-08-01',
        periodTo: '2099-08-01',
        instructorIds: [1],
        studentIds: [1],
        roomIds: [1],
        subjects: ['english'],
        statuses: [],
        groupOnly: false,
        colorBy: 'student',
        countryCode: 'KR',
        modeFilters: ['online'],
        kstFixed: true,
        compactCols: true,
        manualPanes: [{ uid: 1, dim: 'student', ids: [1], countryCode: 'KR', modeFilters: ['online'] }],
      })
      .expect(200);
    await app.close();
  }

  {
    console.log('[asset-smoke] boot app #3');
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    console.log('[asset-smoke] login manager #3');
    const manager = await login(http, 'manager');

    console.log('[asset-smoke] verify updates');
    const availabilityRows = (await http.get('/api/availability?ownerType=student&ownerId=1')
      .set(auth(manager))
      .expect(200)).body as AvailabilityRow[];
    const availability = availabilityRows.find((row) => row.id === availabilityId);
    if (!availability || availability.kind !== 'unavailable' || availability.startTime !== '08:30' || availability.endTime !== '09:00') {
      throw new Error(`availability ${availabilityId} update did not survive restart`);
    }

    const presets = (await http.get('/api/view-presets')
      .set(auth(manager))
      .expect(200)).body as PresetRow[];
    const preset = presets.find((row) => row.id === presetId);
    if (!preset || preset.view !== 'day' || preset.manualPanes?.[0]?.dim !== 'student') {
      throw new Error(`view preset ${presetId} update did not survive restart`);
    }

    console.log('[asset-smoke] delete created assets');
    await http.delete(`/api/availability/${availabilityId}`).set(auth(manager)).expect(200);
    await http.delete(`/api/view-presets/${presetId}`).set(auth(manager)).expect(200);
    await app.close();
  }

  {
    console.log('[asset-smoke] boot app #4');
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    console.log('[asset-smoke] login manager #4');
    const manager = await login(http, 'manager');
    console.log('[asset-smoke] verify deletes');
    const availabilityRows = (await http.get('/api/availability?ownerType=student&ownerId=1')
      .set(auth(manager))
      .expect(200)).body as AvailabilityRow[];
    if (availabilityRows.some((row) => row.id === availabilityId)) {
      throw new Error(`availability ${availabilityId} delete did not survive restart`);
    }
    const presets = (await http.get('/api/view-presets').set(auth(manager)).expect(200)).body as PresetRow[];
    if (presets.some((row) => row.id === presetId)) {
      throw new Error(`view preset ${presetId} delete did not survive restart`);
    }
    await app.close();
  }

  console.log(JSON.stringify({ ok: true, availabilityId, presetId, presetName }));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
