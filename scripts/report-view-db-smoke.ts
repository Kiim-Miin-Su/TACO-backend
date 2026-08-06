import 'reflect-metadata';
import { config } from 'dotenv';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { ClassSessionsStore } from '../src/modules/schedule/class-sessions.store';
import { ReportsService } from '../src/modules/reports/reports.service';
import { COURSES_SPEC, ENROLLMENTS_SPEC, STUDENTS_SPEC } from '../src/database/calendar-asset-specs';
import type { Course } from '../src/modules/courses/course.entity';
import type { Enrollment } from '../src/modules/enrollments/enrollment.entity';
import type { Student } from '../src/modules/students/student.entity';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

function requireDatabase(): void {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for report view DB smoke');
  }
}

async function main(): Promise<void> {
  requireDatabase();
  const stamp = Date.now();
  let sessionId = 0;
  let reportId = 0;
  let instructorId = 0;
  let expectedStudentId = 0;
  let expectedCourseId = 0;

  {
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    const store = app.get(PostgresCollectionStore);
    const sessions = app.get(ClassSessionsStore);
    const reports = app.get(ReportsService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');

    const enrollments = await store.findActive<Enrollment>(ENROLLMENTS_SPEC, {
      orderBy: { field: 'id' },
    });
    const courses = await store.findActive<Course>(COURSES_SPEC);
    const students = await store.findActive<Student>(STUDENTS_SPEC);
    const courseById = new Map(courses.map((row) => [row.id, row]));
    const studentById = new Map(students.map((row) => [row.id, row]));
    const enrollment = enrollments.find((row) => {
      const course = courseById.get(row.courseId);
      return course?.instructorId != null && !!studentById.get(row.studentId);
    });
    if (!enrollment) throw new Error('active enrollment/assigned-course/student fixture is required');
    const course = courseById.get(enrollment.courseId)!;
    if (course.instructorId == null) throw new Error('report smoke requires an assigned course');
    instructorId = course.instructorId;
    expectedStudentId = enrollment.studentId;
    expectedCourseId = course.id;

    const session = await sessions.insert({
      courseId: course.id,
      instructorId,
      sessionDate: '2099-12-29',
      startTime: '23:00',
      endTime: '23:50',
      durationMinutes: 50,
      status: 'scheduled',
      topic: `TBO-76D-report-view-${stamp}`,
      studentIds: [enrollment.studentId],
      kind: 'class',
      mode: 'online',
    });
    sessionId = session.id;

    const report = await reports.create({
      sessionId,
      studentId: enrollment.studentId,
      content: `DB report content ${stamp}`,
      progressPage: 'Vocab #6 PDF 12-15p',
      homework: 'Vocab #6 단어 암기',
      status: 'draft',
    }, { id: instructorId, roles: ['instructor'] });
    reportId = report.id;
    const beforeRestart = await reports.getDbForActor(reportId, {
      id: instructorId,
      roles: ['instructor'],
    });
    if (
      beforeRestart.progressPage !== 'Vocab #6 PDF 12-15p' ||
      beforeRestart.context.student.id !== expectedStudentId ||
      beforeRestart.context.session.id !== sessionId ||
      beforeRestart.context.course.id !== expectedCourseId ||
      beforeRestart.context.instructor.id !== instructorId
    ) {
      throw new Error(`joined report mismatch before restart: ${JSON.stringify(beforeRestart)}`);
    }
    await app.close();
  }

  {
    const app = await createTestApp();
    const reports = app.get(ReportsService);
    const sessions = app.get(ClassSessionsStore);
    const afterRestart = await reports.getDbForActor(reportId, {
      id: instructorId,
      roles: ['instructor'],
    });
    if (
      afterRestart.progressPage !== 'Vocab #6 PDF 12-15p' ||
      afterRestart.context.student.id !== expectedStudentId ||
      afterRestart.context.session.id !== sessionId ||
      afterRestart.context.course.id !== expectedCourseId ||
      afterRestart.context.instructor.id !== instructorId
    ) {
      throw new Error(`joined report mismatch after restart: ${JSON.stringify(afterRestart)}`);
    }
    await reports.removeBySession(sessionId, instructorId);
    await sessions.remove(sessionId, instructorId);
    await app.close();
  }

  console.log(JSON.stringify({
    ok: true,
    sessionId,
    reportId,
    studentId: expectedStudentId,
    courseId: expectedCourseId,
    instructorId,
    restartReadback: true,
    cleanedUp: true,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
