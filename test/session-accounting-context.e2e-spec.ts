import { ConflictException } from '@nestjs/common';
import type { PostgresCollectionSpec } from '../src/database/postgres-collection.store';
import type { Attendance } from '../src/modules/attendance/attendance.entity';
import type { Enrollment } from '../src/modules/enrollments/enrollment.entity';
import type { SessionReportRow } from '../src/modules/reports/report.entity';
import { SessionAccountingContextService } from '../src/modules/schedule/session-accounting-context.service';
import type { ClassSession } from '../src/modules/schedule/schedule.entity';

const SESSION_ID = 701;
const STUDENT_ID = 801;

const session = {
  id: SESSION_ID,
  courseId: 901,
  instructorId: 1001,
  studentIds: [STUDENT_ID],
} as ClassSession;

describe('session accounting fresh context', () => {
  function serviceWith(rows: {
    attendance?: Attendance[];
    reports?: SessionReportRow[];
    enrollments?: Enrollment[];
  }) {
    const findActive = jest.fn(async (spec: PostgresCollectionSpec) => {
      if (spec.table === 'enrollments') return rows.enrollments ?? [];
      return [];
    });
    const findActiveByFieldValues = jest.fn(async (spec: PostgresCollectionSpec) => {
      if (spec.table === 'attendance') return rows.attendance ?? [];
      if (spec.table === 'session_reports') return rows.reports ?? [];
      return [];
    });
    return {
      service: new SessionAccountingContextService({ findActive, findActiveByFieldValues } as never),
      findActive,
      findActiveByFieldValues,
    };
  }

  it('uses fresh DB report rows for payout eligibility and reads each dependency source once', async () => {
    const approved = {
      id: 1,
      sessionId: SESSION_ID,
      studentId: STUDENT_ID,
      approvalStatus: 'approved',
    } as SessionReportRow;
    const { service, findActive, findActiveByFieldValues } = serviceWith({ reports: [approved] });

    const context = await service.loadFresh([SESSION_ID, SESSION_ID]);

    expect(service.isReportComplete(context, session)).toBe(true);
    expect(findActive.mock.calls.map(([spec]) => spec.table)).toEqual(['enrollments']);
    expect(findActiveByFieldValues.mock.calls.map(([spec]) => spec.table)).toEqual([
      'attendance',
      'session_reports',
    ]);
    expect(service.isReportComplete(context, { ...session, studentIds: [STUDENT_ID, 802] })).toBe(false);
  });

  it('rejects a cohort change using the same fresh attendance/report snapshot', async () => {
    const attendance = {
      id: 2,
      sessionId: SESSION_ID,
      studentId: STUDENT_ID,
      status: 'present',
    } as Attendance;
    const { service } = serviceWith({ attendance: [attendance] });
    const context = await service.loadFresh([SESSION_ID]);

    expect(() => service.assertDependentsCompatible(
      context,
      session,
      { courseId: 902, instructorId: session.instructorId, studentIds: [999] },
    )).toThrow(ConflictException);
  });

  it('rejects instructor/course mutation when a fresh report row exists', async () => {
    const draft = {
      id: 3,
      sessionId: SESSION_ID,
      studentId: STUDENT_ID,
      approvalStatus: 'draft',
    } as SessionReportRow;
    const { service } = serviceWith({ reports: [draft] });
    const context = await service.loadFresh([SESSION_ID]);

    expect(() => service.assertDependentsCompatible(
      context,
      session,
      { courseId: session.courseId, instructorId: 1002, studentIds: session.studentIds },
    )).toThrow(`세션 ${SESSION_ID}에 작성된 보고서가 있어 강사를 변경할 수 없습니다`);
  });
});
