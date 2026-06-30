import type { BaseRow } from '../../common/types/base';

export const SESSION_REPORTS = 'session_reports';

/**
 * 수업 보고서 승인 라이프사이클(시수 적격성의 한 축).
 *  draft     — 작성 중(시수 미반영)
 *  submitted — 강사 제출(승인 대기)
 *  approved  — 관리자 승인 → 해당 세션이 시수/페이 산정 대상이 됨
 *  rejected  — 관리자 반려(사유 보존, 재제출 가능)
 * 계약(@kms545487/contracts)의 ReportStatus(draft|submitted|sent)를 정산 도메인에
 * 맞춰 확장한 백엔드 내부 상태. 'approved'가 승인 게이트, 'sent'는 알림 발송 단계와 분리.
 */
export type ReportStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export type SessionReportRow = {
  sessionId: number; // FK → class_sessions.id
  studentId: number; // FK → students.id
  instructorId: number; // FK → users(강사).id (세션 강사와 일치)
  subjectId?: number; // 과목 스냅샷(작성 시점)
  content: string;
  homework?: string;
  status: ReportStatus;
  submittedAt?: string;
  approvedAt?: string;
  approvedBy?: number; // 승인 관리자(데모: 미검증)
  rejectedReason?: string;
} & BaseRow;
