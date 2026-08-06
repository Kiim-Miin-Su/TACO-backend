import type { Attendance } from '../attendance/attendance.entity';
import type { ClassSession } from './schedule.entity';
import type { CohortIndex } from './session-participant.policy';
import { participantIdsForSession } from './session-participant.policy';
import { sessionEndPassed } from './session-time.policy';

type TemporalFields = Pick<ClassSession, 'sessionDate' | 'startTime' | 'durationMinutes'>;
type AttendanceSession = Pick<
  ClassSession,
  'id' | 'courseId' | 'instructorId' | 'studentIds' | 'sessionDate' | 'startTime' | 'durationMinutes' | 'status'
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
  if (session.instructorId == null) {
    return { attendanceRequired: false, missingAttendance: { instructor: false, studentIds: [] } };
  }
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

/**
 * 출결 완결 → held 자동 전이 패치.
 *
 * [TBO-79 D1] held 전이 시점에 **참가자를 확정(freeze)한다.**
 *  명시 코호트가 없는 세션은 `participantIdsForSession`이 매번 *살아있는* 활성 수강으로
 *  재해석한다. 그래서 나중에 수강이 취소·중단되면 이미 끝난 회차의 참가자 집합이 소급해서
 *  바뀌고, 그 위에 얹힌 리포트 완결 판정·정산 적격·출결 배지·무결성 검사까지 함께 흔들렸다.
 *  held = "실제로 일어난 일"이므로 이 시점이 확정의 자연스러운 경계다.
 *  이미 명시 코호트가 있으면 건드리지 않는다 — 스냅샷은 한 번만.
 */
export function attendanceCompletionHoldPatch(
  session: AttendanceSession,
  cohortIndex: CohortIndex,
  attendance: readonly Pick<Attendance, 'studentId'>[],
  nowMs: number,
): { status: 'held'; studentIds?: number[] } | null {
  if (session.instructorId == null || session.status !== 'scheduled' || !sessionEndPassed(session, nowMs)) return null;
  if (session.instructorAttendance == null) return null;
  const participantIds = participantIdsForSession(session, cohortIndex);
  if (!participantIds.length) return null;
  const recordedStudentIds = new Set(attendance.map((row) => Number(row.studentId)));
  if (!participantIds.every((studentId) => recordedStudentIds.has(studentId))) return null;
  return session.studentIds?.length
    ? { status: 'held' }
    : { status: 'held', studentIds: participantIds };
}

/** held는 종료+출결 사실에서만 파생된다. 완료 전이와 완료→예정 역전이는 사실 변경 경로만 허용한다. */
export function isManualCompletionStatusViolation(
  current: ClassSession['status'] | undefined,
  requested: ClassSession['status'] | undefined,
): boolean {
  return (requested === 'held' && current !== 'held')
    || (current === 'held' && requested === 'scheduled');
}

export function isTemporalChangeBlockedStatus(status: ClassSession['status']): boolean {
  return status === 'canceled' || status === 'no_show' || status === 'makeup';
}
