import 'reflect-metadata';
import { config } from 'dotenv';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { ClassSessionsStore } from '../src/modules/schedule/class-sessions.store';
import { ScheduleService } from '../src/modules/schedule/schedule.service';
import { ScheduleReadService } from '../src/modules/schedule/schedule-read.service';
import { AttendanceService } from '../src/modules/attendance/attendance.service';
import { ReportsService } from '../src/modules/reports/reports.service';
import {
  COURSES_SPEC,
  ENROLLMENTS_SPEC,
} from '../src/database/calendar-asset-specs';
import type { Course } from '../src/modules/courses/course.entity';
import type { Enrollment } from '../src/modules/enrollments/enrollment.entity';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

function requireDatabase(): void {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for temporal transition DB smoke');
  }
}

async function main(): Promise<void> {
  requireDatabase();
  const stamp = Date.now();
  let sessionId = 0;
  let reportId = 0;
  let instructorId = 0;
  let studentId = 0;
  const originalStart = '03:13';
  const changedStart = '04:17';

  {
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    const store = app.get(PostgresCollectionStore);
    const sessions = app.get(ClassSessionsStore);
    const schedule = app.get(ScheduleService);
    const attendance = app.get(AttendanceService);
    const reports = app.get(ReportsService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');

    const [enrollments, courses] = await Promise.all([
      store.findActive<Enrollment>(ENROLLMENTS_SPEC, { orderBy: { field: 'id' } }),
      store.findActive<Course>(COURSES_SPEC),
    ]);
    const courseById = new Map(courses.map((row) => [row.id, row]));
    const enrollment = enrollments.find((row) => courseById.has(row.courseId));
    if (!enrollment) throw new Error('active enrollment/course fixture is required');
    const course = courseById.get(enrollment.courseId)!;
    instructorId = course.instructorId;
    studentId = enrollment.studentId;

    const session = await sessions.insert({
      courseId: course.id,
      instructorId,
      sessionDate: '2020-01-02',
      startTime: originalStart,
      durationMinutes: 50,
      status: 'scheduled',
      topic: `TBO-76E-temporal-${stamp}`,
      studentIds: [studentId],
      kind: 'class',
      mode: 'online',
    });
    sessionId = session.id;
    await attendance.upsert(
      { sessionId, studentId, status: 'present' },
      instructorId,
      ['super-admin'],
    );
    await schedule.update(
      sessionId,
      { instructorAttendance: 'present' },
      instructorId,
    );
    const report = await reports.create({
      sessionId,
      studentId,
      content: `TBO-76E preserved report ${stamp}`,
      status: 'submitted',
    }, { id: instructorId, roles: ['instructor'] });
    reportId = report.id;
    await reports.approve(reportId, instructorId);

    let impactHash = '';
    try {
      await schedule.update(sessionId, {
        startTime: changedStart,
        durationMinutes: 50,
      }, instructorId);
      throw new Error('temporal update unexpectedly skipped accounting acknowledgement');
    } catch (error) {
      const response = typeof (error as { getResponse?: unknown }).getResponse === 'function'
        ? (error as { getResponse: () => unknown }).getResponse()
        : null;
      if (!response || typeof response !== 'object' || (response as { code?: string }).code !== 'ACCOUNTING_IMPACT_ACK_REQUIRED') {
        throw error;
      }
      impactHash = String((response as { impactHash?: string }).impactHash ?? '');
    }
    if (!/^[a-f0-9]{64}$/.test(impactHash)) throw new Error('accounting impact hash was not returned');
    const changed = await schedule.update(sessionId, {
      startTime: changedStart,
      durationMinutes: 50,
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: impactHash,
    }, instructorId);
    if (
      changed.row.status !== 'scheduled'
      || changed.row.instructorAttendance != null
      || !changed.row.attendanceRequired
      || changed.row.missingAttendance.studentIds[0] !== studentId
    ) {
      throw new Error(`temporal transition mismatch before restart: ${JSON.stringify(changed.row)}`);
    }
    if ((await attendance.listDbForActor(instructorId, ['super-admin'], sessionId)).length !== 0) {
      throw new Error('attendance rows remained after temporal reset');
    }
    if ((await reports.getDbForActor(reportId, { id: instructorId, roles: ['super-admin'] })).approvalStatus !== 'approved') {
      throw new Error('approved report was not preserved after temporal reset');
    }
    await app.close();
  }

  {
    const app = await createTestApp();
    const read = app.get(ScheduleReadService);
    const reports = app.get(ReportsService);
    const attendance = app.get(AttendanceService);
    const sessions = app.get(ClassSessionsStore);
    await read.ensureReady();
    const afterRestart = read.findOneEnriched(sessionId);
    if (
      afterRestart.startTime !== changedStart
      || afterRestart.status !== 'scheduled'
      || afterRestart.instructorAttendance != null
      || !afterRestart.attendanceRequired
      || afterRestart.missingAttendance.studentIds[0] !== studentId
    ) {
      throw new Error(`temporal transition mismatch after restart: ${JSON.stringify(afterRestart)}`);
    }
    const preserved = await reports.getDbForActor(reportId, { id: instructorId, roles: ['super-admin'] });
    if (preserved.approvalStatus !== 'approved') throw new Error('approved report was not preserved after restart');
    await reports.removeBySession(sessionId, instructorId);
    await attendance.removeBySession(sessionId, instructorId);
    await sessions.remove(sessionId, instructorId);
    await app.close();
  }

  console.log(JSON.stringify({
    ok: true,
    sessionId,
    reportId,
    instructorId,
    studentId,
    impactHashBound: true,
    attendanceReset: true,
    reportPreserved: true,
    restartReadback: true,
    cleanedUp: true,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
