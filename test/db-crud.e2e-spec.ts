import { INestApplication } from '@nestjs/common';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';

const enabled = process.env.RUN_DB_CRUD_E2E === '1';
const describeDb = enabled ? describe : describe.skip;

// [TBO-29C C5] 실 Neon(WAN) 재시작 시나리오 — 부팅×N + 권위 재수화가 왕복 지연을 그대로 받는
//  장기 실행 스위트라 상향(로컬 PG는 수 초 내 완료). 개별 시나리오가 300s를 넘으면 그건 회귀다.
jest.setTimeout(300_000);

type AvailabilityRow = {
  id: number;
  ownerType: string;
  ownerId: number;
  kind: string;
  weekday: number;
  startTime: string;
  endTime: string;
  effectiveFrom?: string;
  effectiveTo?: string;
};

type ViewPresetRow = {
  id: number;
  name: string;
  view: string;
  instructorIds: number[];
  studentIds: number[];
  roomIds: number[];
  manualPanes?: Array<Record<string, unknown>>;
};

type AuditRow = {
  id: number;
  entity: string;
  entityId: number;
  action: string;
  actorId: number;
  changes?: Record<string, unknown>;
};

type ScheduleRow = {
  id: number;
  sessionDate: string;
  topic?: string;
};

async function login(http: ReturnType<typeof request>, webId: string): Promise<string> {
  const res = await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201);
  return res.body.accessToken;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function boot(): Promise<{ app: INestApplication; http: ReturnType<typeof request>; manager: string }> {
  const app = await createTestApp();
  const pg = app.get(PostgresConnectionService);
  expect(pg.ready).toBe(true);
  const http = request(app.getHttpServer());
  const manager = await login(http, 'manager');
  return { app, http, manager };
}

describeDb('Postgres-backed backend CRUD (e2e)', () => {
  beforeAll(() => {
    config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
      throw new Error('DATABASE_URL/POSTGRES_URL is required. Run with RUN_DB_CRUD_E2E=1 DOTENV_CONFIG_PATH=.env.local.');
    }
  });

  it('performs C/R/U/D on availability and persists audit rows across app restarts', async () => {
    const stamp = Date.now();
    const effectiveDate = `2099-10-${String((stamp % 20) + 1).padStart(2, '0')}`;
    let availabilityId = 0;

    {
      const { app, http, manager } = await boot();
      const created = (await http.put('/api/availability')
        .set(auth(manager))
        .send({
          ownerType: 'student',
          ownerId: 1,
          kind: 'online_only',
          weekday: 6,
          startTime: '07:00',
          endTime: '07:30',
          effectiveFrom: effectiveDate,
          effectiveTo: effectiveDate,
        })
        .expect(200)).body as AvailabilityRow;
      availabilityId = created.id;
      expect(created).toMatchObject({ kind: 'online_only', startTime: '07:00', endTime: '07:30' });
      await app.close();
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/availability?ownerType=student&ownerId=1')
        .set(auth(manager))
        .expect(200)).body as AvailabilityRow[];
      expect(rows.find((row) => row.id === availabilityId)).toMatchObject({
        kind: 'online_only',
        startTime: '07:00',
        endTime: '07:30',
      });

      const updated = (await http.put('/api/availability')
        .set(auth(manager))
        .send({
          id: availabilityId,
          ownerType: 'student',
          ownerId: 1,
          kind: 'unavailable',
          weekday: 6,
          startTime: '07:30',
          endTime: '08:00',
          effectiveFrom: effectiveDate,
          effectiveTo: effectiveDate,
        })
        .expect(200)).body as AvailabilityRow;
      expect(updated).toMatchObject({ kind: 'unavailable', startTime: '07:30', endTime: '08:00' });
      await app.close();
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/availability?ownerType=student&ownerId=1')
        .set(auth(manager))
        .expect(200)).body as AvailabilityRow[];
      expect(rows.find((row) => row.id === availabilityId)).toMatchObject({
        kind: 'unavailable',
        startTime: '07:30',
        endTime: '08:00',
      });

      const auditBeforeDelete = (await http.get(`/api/audit?entity=availability_blocks&entityId=${availabilityId}`)
        .set(auth(manager))
        .expect(200)).body as AuditRow[];
      expect(auditBeforeDelete.some((row) => row.action === 'create' && row.changes?.__row)).toBe(true);
      expect(auditBeforeDelete.some((row) => row.action === 'update' && row.changes?.kind)).toBe(true);

      await http.delete(`/api/availability/${availabilityId}`).set(auth(manager)).expect(200);
      await app.close();
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/availability?ownerType=student&ownerId=1')
        .set(auth(manager))
        .expect(200)).body as AvailabilityRow[];
      expect(rows.some((row) => row.id === availabilityId)).toBe(false);

      const auditAfterDelete = (await http.get(`/api/audit?entity=availability_blocks&entityId=${availabilityId}`)
        .set(auth(manager))
        .expect(200)).body as AuditRow[];
      expect(auditAfterDelete.some((row) => row.action === 'delete' && row.changes?.__row)).toBe(true);
      await app.close();
    }
  });

  it('performs C/R/U/D on calendar view presets across app restarts', async () => {
    const stamp = Date.now();
    const name = `DB-CRUD-${stamp}`;
    let presetId = 0;

    {
      const { app, http, manager } = await boot();
      const created = (await http.post('/api/view-presets')
        .set(auth(manager))
        .send({
          name,
          view: 'week',
          periodFrom: '2099-10-01',
          periodTo: '2099-10-07',
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
          compactCols: false,
          manualPanes: [{ uid: 1, dim: 'instructor', ids: [1], countryCode: 'KR' }],
        })
        .expect(201)).body as ViewPresetRow;
      presetId = created.id;
      expect(created).toMatchObject({ name, view: 'week' });
      await app.close();
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/view-presets').set(auth(manager)).expect(200)).body as ViewPresetRow[];
      expect(rows.find((row) => row.id === presetId)).toMatchObject({
        name,
        view: 'week',
        instructorIds: [1],
      });

      const updated = (await http.patch(`/api/view-presets/${presetId}`)
        .set(auth(manager))
        .send({
          name,
          view: 'day',
          periodFrom: '2099-10-02',
          periodTo: '2099-10-02',
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
          manualPanes: [{ uid: 1, dim: 'student', ids: [1], countryCode: 'KR' }],
        })
        .expect(200)).body as ViewPresetRow;
      expect(updated).toMatchObject({ name, view: 'day', compactCols: true });
      await app.close();
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/view-presets').set(auth(manager)).expect(200)).body as ViewPresetRow[];
      expect(rows.find((row) => row.id === presetId)).toMatchObject({
        view: 'day',
        compactCols: true,
      });
      await http.delete(`/api/view-presets/${presetId}`).set(auth(manager)).expect(200);
      await app.close();
    }

    {
      const { app, http, manager } = await boot();
      const rows = (await http.get('/api/view-presets').set(auth(manager)).expect(200)).body as ViewPresetRow[];
      expect(rows.some((row) => row.id === presetId)).toBe(false);
      const recreated = (await http.post('/api/view-presets')
        .set(auth(manager))
        .send({
          name,
          view: 'week',
          instructorIds: [1],
          studentIds: [],
          roomIds: [],
          subjects: [],
          statuses: [],
          groupOnly: false,
        })
        .expect(201)).body as ViewPresetRow;
      expect(recreated.name).toBe(name);
      await http.delete(`/api/view-presets/${recreated.id}`).set(auth(manager)).expect(200);
      await app.close();
    }
  });

  it('refreshes the warm calendar read model from Postgres on every read', async () => {
    const { app, http, manager } = await boot();
    const pg = app.get(PostgresConnectionService).getDataSource();
    const stamp = Date.now();
    const originalTopic = `DB-REFRESH-${stamp}`;
    const updatedTopic = `${originalTopic}-UPDATED`;
    let sessionId = 0;

    try {
      const [created] = await pg.query(
        `INSERT INTO class_sessions
          (course_id, instructor_id, room_id, session_date, start_time, end_time, duration_minutes, status, kind, mode, topic, student_ids)
         VALUES (10, 1, 1, '2099-12-29', '08:00', '09:00', 60, 'scheduled', 'class', 'online', $1, '[]')
         RETURNING id`,
        [originalTopic],
      );
      sessionId = Number(created.id);

      const first = (await http.get('/api/schedule?from=2099-12-29&to=2099-12-29')
        .set(auth(manager))
        .expect(200)).body as ScheduleRow[];
      expect(first.find((row) => row.id === sessionId)?.topic).toBe(originalTopic);

      await pg.query('UPDATE class_sessions SET topic = $1, updated_at = now() WHERE id = $2', [updatedTopic, sessionId]);
      const updated = (await http.get('/api/schedule?from=2099-12-29&to=2099-12-29')
        .set(auth(manager))
        .expect(200)).body as ScheduleRow[];
      expect(updated.find((row) => row.id === sessionId)?.topic).toBe(updatedTopic);

      await pg.query('UPDATE class_sessions SET deleted_at = now(), updated_at = now() WHERE id = $1', [sessionId]);
      const removed = (await http.get('/api/schedule?from=2099-12-29&to=2099-12-29')
        .set(auth(manager))
        .expect(200)).body as ScheduleRow[];
      expect(removed.some((row) => row.id === sessionId)).toBe(false);
    } finally {
      if (sessionId) await pg.query('DELETE FROM class_sessions WHERE id = $1', [sessionId]);
      await app.close();
    }
  });
});
