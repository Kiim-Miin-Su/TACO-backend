import 'reflect-metadata';
import { DataSource, type EntityManager } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';

loadLocalEnv();

type Fixture = {
  id: number;
  seriesId: number | null;
  courseId: number;
  instructorId: number;
  roomId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  mode: 'in_person' | 'online';
  topic: string;
};

const apply = process.env.APPLY === '1';
const url = directDatabaseUrl();

if (!url) {
  console.error('DATABASE_URL_UNPOOLED, DATABASE_URL, POSTGRES_URL_NON_POOLING, or POSTGRES_URL is required');
  process.exit(1);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function mondayOf(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const weekday = date.getUTCDay();
  return addDays(iso, weekday === 0 ? -6 : 1 - weekday);
}

const anchor = process.env.DEMO_CALENDAR_ANCHOR ?? new Date().toISOString().slice(0, 10);
const monday = mondayOf(anchor);
const seriesId = 10001;
const fixtures: Fixture[] = [
  {
    id: 10001,
    seriesId: null,
    courseId: 12,
    instructorId: 1,
    roomId: 2,
    sessionDate: addDays(monday, 2),
    startTime: '18:00',
    endTime: '19:30',
    durationMinutes: 90,
    mode: 'online',
    topic: 'TOEFL Writing 통합형 첨삭',
  },
  ...[1, 3, 8].map((offset, index): Fixture => ({
    id: 10002 + index,
    seriesId,
    courseId: 11,
    instructorId: 2,
    roomId: 3,
    sessionDate: addDays(monday, offset),
    startTime: '16:00',
    endTime: '18:00',
    durationMinutes: 120,
    mode: 'in_person',
    topic: `AP Calculus BC 적분 응용 ${index + 1}`,
  })),
];

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  migrations: [],
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  extra: {
    max: Number(process.env.DB_POOL_MAX ?? 1),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
  },
});

async function assertFixtureIntegrity(manager: EntityManager, fixture: Fixture): Promise<void> {
  const [assets] = await manager.query(
    `SELECT
       EXISTS (SELECT 1 FROM courses WHERE id = $1 AND deleted_at IS NULL) AS course_ok,
       EXISTS (SELECT 1 FROM users WHERE id = $2 AND role = 'instructor' AND deleted_at IS NULL) AS instructor_ok,
       EXISTS (SELECT 1 FROM rooms WHERE id = $3 AND is_active = true AND deleted_at IS NULL) AS room_ok,
       EXISTS (SELECT 1 FROM enrollments WHERE course_id = $1 AND status = 'active' AND deleted_at IS NULL) AS cohort_ok`,
    [fixture.courseId, fixture.instructorId, fixture.roomId],
  ) as Array<{ course_ok: boolean; instructor_ok: boolean; room_ok: boolean; cohort_ok: boolean }>;
  if (!assets?.course_ok || !assets.instructor_ok || !assets.room_ok || !assets.cohort_ok) {
    throw new Error(`fixture ${fixture.id} reference integrity failed: ${JSON.stringify(assets)}`);
  }

  const conflicts = await manager.query(
    `SELECT id, topic
       FROM class_sessions
      WHERE deleted_at IS NULL
        AND id <> ALL($1::int[])
        AND session_date = $2::date
        AND (instructor_id = $3 OR room_id = $4)
        AND start_time::time < $6::time
        AND COALESCE(end_time::time, start_time::time + duration_minutes * interval '1 minute') > $5::time`,
    [fixtures.map((row) => row.id), fixture.sessionDate, fixture.instructorId, fixture.roomId, fixture.startTime, fixture.endTime],
  ) as Array<{ id: number; topic?: string }>;
  if (conflicts.length) throw new Error(`fixture ${fixture.id} conflicts with sessions: ${JSON.stringify(conflicts)}`);

  const restricted = await manager.query(
    `SELECT b.id, b.owner_type, b.owner_id, b.kind, b.start_time, b.end_time
       FROM availability_blocks b
      WHERE b.deleted_at IS NULL
        AND b.weekday = extract(dow FROM $1::date)::int
        AND (b.effective_from IS NULL OR b.effective_from <= $1::date)
        AND (b.effective_to IS NULL OR b.effective_to >= $1::date)
        AND b.start_time::time < $3::time
        AND b.end_time::time > $2::time
        AND (b.kind = 'unavailable' OR (b.kind = 'online_only' AND $4 <> 'online'))
        AND (
          (b.owner_type = 'instructor' AND b.owner_id = $5) OR
          (b.owner_type = 'room' AND b.owner_id = $6) OR
          (b.owner_type = 'student' AND b.owner_id IN (
            SELECT student_id FROM enrollments
             WHERE course_id = $7 AND status = 'active' AND deleted_at IS NULL
          ))
        )`,
    [fixture.sessionDate, fixture.startTime, fixture.endTime, fixture.mode, fixture.instructorId, fixture.roomId, fixture.courseId],
  ) as Array<{ id: number; owner_type: string; owner_id: number; kind: string }>;
  if (restricted.length) throw new Error(`fixture ${fixture.id} violates availability: ${JSON.stringify(restricted)}`);
}

async function upsertFixture(manager: EntityManager, fixture: Fixture): Promise<void> {
  await manager.query(
    `INSERT INTO class_sessions
       (id, series_id, course_id, instructor_id, room_id, session_date, start_time, end_time,
        duration_minutes, status, kind, mode, topic, memo, student_ids, created_at, updated_at, deleted_at, deleted_by)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, 'scheduled', 'class', $10, $11,
             'calendar-demo-v1', '[]', now(), now(), NULL, NULL)
     ON CONFLICT (id) DO UPDATE SET
       series_id = EXCLUDED.series_id,
       course_id = EXCLUDED.course_id,
       instructor_id = EXCLUDED.instructor_id,
       room_id = EXCLUDED.room_id,
       session_date = EXCLUDED.session_date,
       start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time,
       duration_minutes = EXCLUDED.duration_minutes,
       status = EXCLUDED.status,
       kind = EXCLUDED.kind,
       mode = EXCLUDED.mode,
       topic = EXCLUDED.topic,
       memo = EXCLUDED.memo,
       student_ids = EXCLUDED.student_ids,
       payout_id = NULL,
       instructor_pay_amount = NULL,
       instructor_attendance = NULL,
       updated_at = now(),
       deleted_at = NULL,
       deleted_by = NULL`,
    [
      fixture.id,
      fixture.seriesId,
      fixture.courseId,
      fixture.instructorId,
      fixture.roomId,
      fixture.sessionDate,
      fixture.startTime,
      fixture.endTime,
      fixture.durationMinutes,
      fixture.mode,
      fixture.topic,
    ],
  );
}

async function main(): Promise<void> {
  await dataSource.initialize();
  try {
    await dataSource.transaction(async (manager) => {
      for (const fixture of fixtures) await assertFixtureIntegrity(manager, fixture);
      if (!apply) return;
      for (const fixture of fixtures) await upsertFixture(manager, fixture);
      await manager.query(
        `SELECT setval(pg_get_serial_sequence('class_sessions', 'id'), COALESCE((SELECT MAX(id) FROM class_sessions), 1), true)`,
      );
    });

    const rows = await dataSource.query(
      `SELECT id, series_id, course_id, instructor_id, room_id, session_date::text, start_time, end_time, mode, topic
         FROM class_sessions
        WHERE id = ANY($1::int[]) AND deleted_at IS NULL
        ORDER BY id`,
      [fixtures.map((fixture) => fixture.id)],
    );
    if (apply && rows.length !== fixtures.length) throw new Error(`expected ${fixtures.length} fixture rows, got ${rows.length}`);
    console.log(JSON.stringify({
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      anchor,
      fixtures,
      persisted: rows,
    }, null, 2));
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
