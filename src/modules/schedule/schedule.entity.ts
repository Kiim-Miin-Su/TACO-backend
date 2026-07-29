import type { ClassSession as ClassSessionContract, InstructorAttendanceStatus, SessionStatus } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

/**
 * 공개 ClassSession 계약에 노출하지 않는 DB 전용 회계·레거시 연결 컬럼.
 * store와 정산 command는 이 타입을 사용해 물리 컬럼 쓰기를 컴파일 단계에서 검증한다.
 */
export type PersistedClassSessionFields = {
  enrollmentId?: number | null;
  studentId?: number | null;
  payoutId?: number | null;
  instructorPayAmount?: number | null;
  isPaid?: boolean;
  paidPayoutId?: number | null;
};

export type ClassSession = ClassSessionContract & PersistedClassSessionFields & BaseRow;
export type PersistedClassSessionRow = ClassSession;
export const SESSIONS = 'class_sessions';

// [TBO-65 P2 M5 2026-07-26] 상태 유니온의 **런타임 배열 진실원** — DTO IsIn·store CHECK가 공유.
//  종전 4곳 사본(create/update/series DTO·class-sessions.store) 수렴. 계약 타입과의 정합은
//  satisfies가 컴파일 타임에 강제(값 추가/오타 = 즉시 tsc 오류).
export const SESSION_STATUSES = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'] as const satisfies readonly SessionStatus[];
export const INSTRUCTOR_ATT_STATUSES = ['present', 'late', 'absent', 'makeup'] as const satisfies readonly InstructorAttendanceStatus[];
