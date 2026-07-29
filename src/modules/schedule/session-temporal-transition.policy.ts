import type { Attendance } from '../attendance/attendance.entity';
import type { ClassSession } from './schedule.entity';
import type { CohortIndex } from './session-participant.policy';
import { participantIdsForSession } from './session-participant.policy';
import { sessionEndPassed, sessionStartPassed } from './session-time.policy';

type TemporalFields = Pick<ClassSession, 'sessionDate' | 'startTime' | 'durationMinutes'>;
type AttendanceSession = Pick<
  ClassSession,
  'id' | 'courseId' | 'studentIds' | 'sessionDate' | 'startTime' | 'durationMinutes' | 'status'
> & {
  instructorAttendance?: ClassSession['instructorAttendance'] | null;
};

export const TEMPORAL_RESET_AUDIT_REASON = '수업 시간 변경에 따른 출결 초기화';

export type AttendanceRequirement = {
  attendanceRequired: boolean;
  missingAttendance: {
    instructor: boolean;
    studentIds: number[];
  };
};

export function hasSessionTemporalChange(before: TemporalFields, after: TemporalFields): boolean {
  return before.sessionDate !== after.sessionDate
    || before.startTime !== after.startTime
    || before.durationMinutes !== after.durationMinutes;
}

export function attendanceRequirementOf(
  session: AttendanceSession,
  cohortIndex: CohortIndex,
  attendance: readonly Pick<Attendance, 'studentId'>[],
  nowMs: number,
): AttendanceRequirement {
  const participantIds = participantIdsForSession(session, cohortIndex);
  const recordedStudentIds = new Set(attendance.map((row) => Number(row.studentId)));
  const missingStudentIds = participantIds.filter((studentId) => !recordedStudentIds.has(studentId));
  const missingInstructor = session.instructorAttendance == null;
  const requires = session.status !== 'canceled'
    && session.status !== 'no_show'
    && sessionEndPassed(session, nowMs)
    && (missingInstructor || missingStudentIds.length > 0);
  return {
    attendanceRequired: requires,
    missingAttendance: {
      instructor: requires && missingInstructor,
      studentIds: requires ? missingStudentIds : [],
    },
  };
}

export function attendanceCompletionHoldPatch(
  session: AttendanceSession,
  cohortIndex: CohortIndex,
  attendance: readonly Pick<Attendance, 'studentId'>[],
  nowMs: number,
): { status: 'held' } | null {
  if (session.status !== 'scheduled' || !sessionStartPassed(session, nowMs)) return null;
  if (session.instructorAttendance == null) return null;
  const participantIds = participantIdsForSession(session, cohortIndex);
  if (!participantIds.length) return null;
  const recordedStudentIds = new Set(attendance.map((row) => Number(row.studentId)));
  return participantIds.every((studentId) => recordedStudentIds.has(studentId))
    ? { status: 'held' }
    : null;
}

export function isTemporalChangeBlockedStatus(status: ClassSession['status']): boolean {
  return status === 'canceled' || status === 'no_show' || status === 'makeup';
}
