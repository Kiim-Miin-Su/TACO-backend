import type {
  ReportWorklist,
  ReportWorklistItemType,
  ReportWorklistQuery,
} from '@kms545487/contracts';
import type { Enrollment } from '../enrollments/enrollment.entity';
import type { ClassSession } from '../schedule/schedule.entity';
import { buildCohortIndex, participantIdsForSession } from '../schedule/session-participant.policy';
import { sessionEndPassed } from '../schedule/session-time.policy';
import type { SessionReportRow } from './report.entity';

export type ReportWorklistPolicyInput = {
  sessions: readonly ClassSession[];
  enrollments: readonly Enrollment[];
  reports: readonly SessionReportRow[];
  subjectIdByCourse: ReadonlyMap<number, number>;
  query: ReportWorklistQuery;
  effectiveInstructorId?: number;
  nowMs: number;
};

const actionableType = (report?: SessionReportRow): ReportWorklistItemType | null => {
  if (!report) return 'report_missing';
  if (report.approvalStatus === 'rejected') return 'report_rejected';
  if (report.approvalStatus === 'draft' || report.status === 'draft') return 'report_draft';
  return null;
};

/** 목록·대시보드·내비게이션이 공유하는 학생별 리포트 작성 필요 모집단. */
export function buildReportWorklist(input: ReportWorklistPolicyInput): ReportWorklist {
  const cohort = buildCohortIndex(input.enrollments);
  const reportByKey = new Map(input.reports.map((row) => [`${row.sessionId}:${row.studentId}`, row]));
  const items: ReportWorklist['items'] = [];

  const sessions = input.sessions
    .filter((session) =>
      session.status === 'held'
      && session.instructorId != null
      && sessionEndPassed(session, input.nowMs)
      && (input.query.from == null || session.sessionDate >= input.query.from)
      && (input.query.to == null || session.sessionDate <= input.query.to)
      && (input.effectiveInstructorId == null || session.instructorId === input.effectiveInstructorId),
    )
    .sort((a, b) => `${a.sessionDate}:${a.startTime ?? ''}:${a.id}`.localeCompare(`${b.sessionDate}:${b.startTime ?? ''}:${b.id}`));

  for (const session of sessions) {
    const instructorId = session.instructorId;
    if (instructorId == null) continue;
    for (const studentId of participantIdsForSession(session, cohort)) {
      if (input.query.studentId != null && studentId !== input.query.studentId) continue;
      const report = reportByKey.get(`${session.id}:${studentId}`);
      const subjectId = report?.subjectId ?? input.subjectIdByCourse.get(session.courseId);
      if (input.query.subjectId != null && subjectId !== input.query.subjectId) continue;
      const type = actionableType(report);
      if (!type) continue;
      items.push({
        id: `report:${session.id}:${studentId}`,
        type,
        sessionId: session.id,
        instructorId,
        studentId,
        ...(report ? { reportId: report.id } : {}),
        ...(subjectId == null ? {} : { subjectId }),
        sessionDate: session.sessionDate,
        startTime: session.startTime,
        topic: session.topic,
        ...(report?.rejectedReason ? { rejectedReason: report.rejectedReason } : {}),
      });
    }
  }

  return {
    from: input.query.from ?? null,
    to: input.query.to ?? null,
    ...(input.effectiveInstructorId == null ? {} : { instructorId: input.effectiveInstructorId }),
    items,
    itemCount: items.length,
    sessionCount: new Set(items.map((item) => item.sessionId)).size,
  };
}
