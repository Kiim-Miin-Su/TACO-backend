import type { PayReadiness, PayReadinessIssue, PayReadinessIssueType } from '@kms545487/contracts';
import type { Enrollment } from '../enrollments/enrollment.entity';
import type { SessionReportRow } from '../reports/report.entity';
import type { ClassSession } from '../schedule/schedule.entity';
import { buildCohortIndex, participantIdsForSession } from '../schedule/session-participant.policy';
import { countsForTeachingHours } from '../schedule/session-accounting.policy';

type ReadinessSession = ClassSession & {
  payoutId?: number | null;
  isPaid?: boolean;
};

export type PayoutReadinessInput = {
  sessions: readonly ReadinessSession[];
  enrollments: readonly Enrollment[];
  reports: readonly SessionReportRow[];
  periodStart: string;
  periodEnd: string;
  instructorId?: number;
  effectiveRateOf: (courseId: number) => number | undefined;
  nowDate: string;
  nowTime: string;
};

const reportIssueType = (report?: SessionReportRow): PayReadinessIssueType | null => {
  if (!report) return 'report_missing';
  if (report.approvalStatus === 'approved') return null;
  if (report.approvalStatus === 'rejected') return 'report_rejected';
  if (report.approvalStatus === 'submitted' || report.status === 'submitted') return 'report_pending_approval';
  return 'report_draft';
};

const isPastScheduledSession = (
  session: Pick<ClassSession, 'sessionDate' | 'startTime' | 'endTime' | 'durationMinutes'>,
  nowDate: string,
  nowTime: string,
): boolean => {
  if (session.sessionDate !== nowDate) return session.sessionDate < nowDate;
  const end = session.endTime ?? (() => {
    const [hour, minute] = (session.startTime ?? '00:00').split(':').map(Number);
    const total = hour * 60 + minute + session.durationMinutes;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  })();
  return end <= nowTime;
};

const issue = (
  type: PayReadinessIssueType,
  session: ReadinessSession,
  extra: Pick<PayReadinessIssue, 'studentId' | 'reportId' | 'rejectedReason'> = {},
): PayReadinessIssue => ({
  id: extra.studentId != null
    ? `report:${session.id}:${extra.studentId}`
    : `${type.replace(/_/g, '-')}:${session.id}`,
  type,
  sessionId: session.id,
  instructorId: session.instructorId,
  sessionDate: session.sessionDate,
  startTime: session.startTime,
  topic: session.topic,
  ...extra,
});

/**
 * 시수·페이 적격성과 누락 항목을 함께 계산하는 순수 정책.
 * 리포트는 세션 단위가 아니라 실제 코호트의 (session, student) 단위로 완전성을 검사한다.
 */
export function evaluatePayoutReadiness(input: PayoutReadinessInput): PayReadiness {
  const cohortIndex = buildCohortIndex(input.enrollments);
  const reportsByKey = new Map(input.reports.map((row) => [`${row.sessionId}:${row.studentId}`, row]));
  const eligibleSessionIds: number[] = [];
  const issues: PayReadinessIssue[] = [];

  const candidates = input.sessions
    .filter((session) =>
      session.sessionDate >= input.periodStart
      && session.sessionDate <= input.periodEnd
      && (input.instructorId == null || session.instructorId === input.instructorId)
      && session.payoutId == null
      && session.isPaid !== true,
    )
    .sort((a, b) => `${a.sessionDate}:${a.startTime}:${a.id}`.localeCompare(`${b.sessionDate}:${b.startTime}:${b.id}`));

  for (const session of candidates) {
    if (session.status === 'scheduled') {
      if (isPastScheduledSession(session, input.nowDate, input.nowTime)) {
        issues.push(issue('session_execution_missing', session));
      }
      continue;
    }
    // 취소·노쇼·보강 예정은 보강 정책의 책임이며 정산 준비 알림에 중복시키지 않는다.
    if (session.status !== 'held') continue;

    const sessionIssues: PayReadinessIssue[] = [];
    if (!countsForTeachingHours(session)) {
      sessionIssues.push(issue('session_execution_missing', session));
    }

    const participantIds = participantIdsForSession(session, cohortIndex);
    if (participantIds.length === 0) {
      sessionIssues.push(issue('session_roster_missing', session));
    } else {
      for (const studentId of participantIds) {
        const report = reportsByKey.get(`${session.id}:${studentId}`);
        const type = reportIssueType(report);
        if (type) {
          sessionIssues.push(issue(type, session, {
            studentId,
            reportId: report?.id,
            rejectedReason: report?.rejectedReason,
          }));
        }
      }
    }

    const rate = input.effectiveRateOf(session.courseId);
    if (rate == null || rate <= 0) sessionIssues.push(issue('rate_missing', session));

    if (sessionIssues.length === 0) eligibleSessionIds.push(session.id);
    else issues.push(...sessionIssues);
  }

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    ...(input.instructorId == null ? {} : { instructorId: input.instructorId }),
    eligibleSessionIds,
    issues,
    issueCount: issues.length,
  };
}
