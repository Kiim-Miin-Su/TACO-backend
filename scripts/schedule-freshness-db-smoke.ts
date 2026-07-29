import 'reflect-metadata';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { COURSES_SPEC, USERS_SPEC } from '../src/database/calendar-asset-specs';
import type { Course } from '../src/modules/courses/course.entity';
import type { StaffAccount } from '../src/modules/users/user.entity';
import { AuthService } from '../src/modules/auth/auth.service';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

const requireDatabase = () => {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for schedule freshness DB smoke');
  }
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function main(): Promise<void> {
  requireDatabase();
  const appA = await createTestApp();
  const appB = await createTestApp();
  let sessionId = 0;
  let createdCourseId = 0;
  try {
    const pg = appA.get(PostgresConnectionService);
    if (!pg.ready || !appB.get(PostgresConnectionService).ready) throw new Error('both Postgres app instances must be ready');
    const store = appA.get(PostgresCollectionStore);
    const users = await store.findActive<StaffAccount>(USERS_SPEC);
    const courses = await store.findActive<Course>(COURSES_SPEC);
    const instructor = users.find((row) => row.role === 'instructor' && row.status === 'active');
    const managerAccount = users.find((row) =>
      ['super_admin', 'admin', 'manager'].includes(row.role) && row.status === 'active');
    const httpA = request(appA.getHttpServer());
    const httpB = request(appB.getHttpServer());
    if (!instructor || !managerAccount) throw new Error('active instructor and manager fixtures are required');
    const manager = appA.get(AuthService).sign({
      sub: managerAccount.id,
      name: managerAccount.name,
      roles: [managerAccount.role],
      authVersion: managerAccount.authVersion ?? 1,
    });
    const instructorToken = appB.get(AuthService).sign({
      sub: instructor.id,
      name: instructor.name,
      roles: [instructor.role],
      authVersion: instructor.authVersion ?? 1,
    });
    let course = courses[0];
    if (!course) {
      const subjects = (await httpA.get('/api/subjects').set(auth(manager)).expect(200)).body as Array<{ id: number }>;
      if (!subjects[0]) throw new Error('one active subject fixture is required');
      course = (await httpA.post('/api/courses').set(auth(manager)).send({
        name: `TBO-76F 임시 코스 ${Date.now()}`,
        subjectId: subjects[0].id,
        instructorId: instructor.id,
        price: 0,
        hourlyRate: 0,
      }).expect(201)).body as Course;
      createdCourseId = course.id;
    }
    const date = '2099-12-30';

    const before = await httpB.get('/api/schedule').query({ from: date, to: date })
      .set(auth(instructorToken)).expect(200);
    const created = await httpA.post('/api/schedule').set(auth(manager)).send({
      courseId: course.id,
      instructorId: instructor.id,
      studentIds: [],
      sessionDate: date,
      startTime: '22:10',
      durationMinutes: 40,
      mode: 'online',
      topic: `TBO-76F-fresh-${Date.now()}`,
      force: true,
    }).expect(201);
    sessionId = created.body.row.id;

    const after = await httpB.get('/api/schedule').query({ from: date, to: date })
      .set(auth(instructorToken)).expect(200);
    if (!after.body.some((row: { id: number }) => row.id === sessionId)) {
      throw new Error(`second instance did not read created session ${sessionId}`);
    }
    if (after.headers['x-schedule-read-source'] !== 'postgres') {
      throw new Error(`unexpected read source: ${after.headers['x-schedule-read-source']}`);
    }
    const dbRows = await pg.query<{ id: number }>(
      'SELECT id FROM class_sessions WHERE id = $1 AND deleted_at IS NULL',
      [sessionId],
    );
    if (dbRows.length !== 1) throw new Error('created session is not durable in PostgreSQL');

    await httpA.delete(`/api/schedule/${sessionId}`).set(auth(manager)).expect(200);
    if (createdCourseId) await httpA.delete(`/api/courses/${createdCourseId}`).set(auth(manager)).expect(200);
    const cleaned = await pg.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM class_sessions WHERE id = $1 AND deleted_at IS NULL',
      [sessionId],
    );
    if (cleaned[0]?.count !== '0') throw new Error('QA session cleanup failed');

    console.log(JSON.stringify({
      ok: true,
      sessionId,
      beforeCount: before.body.length,
      responseContainsCreatedId: true,
      readSource: after.headers['x-schedule-read-source'],
      catalogHydrateAgeMs: Number(after.headers['x-schedule-catalog-hydrate-age-ms']),
      postgresReadback: true,
      cleanedUp: true,
    }));
  } finally {
    await Promise.allSettled([appA.close(), appB.close()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
