import { ConflictException, Injectable } from '@nestjs/common';
import {
  ATTENDANCE_SPEC,
  ENROLLMENTS_SPEC,
  SESSION_REPORTS_SPEC,
} from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import type { Attendance } from '../attendance/attendance.entity';
import type { Enrollment } from '../enrollments/enrollment.entity';
import type { SessionReportRow } from '../reports/report.entity';
import type { ClassSession } from './schedule.entity';
import {
  buildCohortIndex,
  participantIdsForSession,
  studentBelongsToSessionIndexed,
  type CohortIndex,
} from './session-participant.policy';

type SessionDependents = {
  attendance: Attendance[];
  reports: SessionReportRow[];
};

export type SessionAccountingContext = {
  cohortIndex: CohortIndex;
  bySessionId: Map<number, SessionDependents>;
};

@Injectable()
export class SessionAccountingContextService {
  constructor(private readonly store: PostgresCollectionStore) {}

  /**
   * session advisory lock을 획득한 뒤 호출한다. 메모리 미러가 아니라 PostgreSQL 활성 행을
   * 직접 읽어 회계 미리보기와 종속 참조 검증이 같은 스냅샷을 사용하게 한다.
   */
  async loadFresh(sessionIds: readonly number[]): Promise<SessionAccountingContext> {
    const ids = [...new Set(sessionIds.map(Number))].sort((a, b) => a - b);
    const enrollments = await this.store.findActive<Enrollment>(ENROLLMENTS_SPEC);
    const attendance = await this.store.findActiveByFieldValues<Attendance>(
      ATTENDANCE_SPEC,
      'sessionId',
      ids,
    );
    const reports = await this.store.findActiveByFieldValues<SessionReportRow>(
      SESSION_REPORTS_SPEC,
      'sessionId',
      ids,
    );
    const bySessionId = new Map<number, SessionDependents>(
      ids.map((sessionId) => [sessionId, { attendance: [], reports: [] }]),
    );
    for (const row of attendance) {
      bySessionId.get(Number(row.sessionId))?.attendance.push(row);
    }
    for (const row of reports) {
      bySessionId.get(Number(row.sessionId))?.reports.push(row);
    }
    return { cohortIndex: buildCohortIndex(enrollments), bySessionId };
  }

  isReportComplete(
    context: SessionAccountingContext,
    session: Pick<ClassSession, 'id' | 'courseId' | 'studentIds'>,
  ): boolean {
    const participantIds = participantIdsForSession(session, context.cohortIndex);
    if (!participantIds.length) return false;
    const approved = new Set(
      (context.bySessionId.get(session.id)?.reports ?? [])
        .filter((row) => row.approvalStatus === 'approved')
        .map((row) => Number(row.studentId)),
    );
    return participantIds.every((studentId) => approved.has(studentId));
  }

  assertDependentsCompatible(
    context: SessionAccountingContext,
    before: ClassSession,
    after: Pick<ClassSession, 'courseId' | 'studentIds' | 'instructorId'>,
  ): void {
    const dependents = context.bySessionId.get(before.id) ?? { attendance: [], reports: [] };
    const dependentStudents = new Set([
      ...dependents.attendance.map((row) => Number(row.studentId)),
      ...dependents.reports.map((row) => Number(row.studentId)),
    ]);
    const invalid = [...dependentStudents].filter(
      (studentId) => !studentBelongsToSessionIndexed(after, studentId, context.cohortIndex),
    );
    if (invalid.length) {
      throw new ConflictException(
        `세션 ${before.id}의 출결/보고서 학생이 변경 코호트에서 제외됩니다: ${invalid.join(', ')}`,
      );
    }
    if (dependents.reports.length && after.instructorId !== before.instructorId) {
      throw new ConflictException(`세션 ${before.id}에 작성된 보고서가 있어 강사를 변경할 수 없습니다`);
    }
    if (dependents.reports.length && after.courseId !== before.courseId) {
      throw new ConflictException(`세션 ${before.id}에 작성된 보고서가 있어 코스를 변경할 수 없습니다`);
    }
  }
}
