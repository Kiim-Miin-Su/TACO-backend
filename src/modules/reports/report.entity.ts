import type {
  ReportApprovalStatus,
  ReportStatus,
  SessionReport as SessionReportContract,
  SessionReportView,
} from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export const SESSION_REPORTS = 'session_reports';

/**
 * 수업 보고서 상태.
 *  - status: 작성/발송 상태(draft|submitted|sent)
 *  - approvalStatus: 승인 워크플로우(draft|submitted|approved|rejected)
 * 시수/페이 산정은 approvalStatus=approved인 held 세션만 대상으로 한다.
 */
export type { ReportApprovalStatus, ReportStatus };
export type SessionReportRow = SessionReportContract & BaseRow;
export type SessionReportViewRow = SessionReportView & BaseRow;
