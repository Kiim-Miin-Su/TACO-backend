import type { ClassSession as ClassSessionContract, InstructorAttendanceStatus, SessionStatus } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type ClassSession = ClassSessionContract & BaseRow;
export const SESSIONS = 'class_sessions';

// [TBO-65 P2 M5 2026-07-26] 상태 유니온의 **런타임 배열 진실원** — DTO IsIn·store CHECK가 공유.
//  종전 4곳 사본(create/update/series DTO·class-sessions.store) 수렴. 계약 타입과의 정합은
//  satisfies가 컴파일 타임에 강제(값 추가/오타 = 즉시 tsc 오류).
export const SESSION_STATUSES = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'] as const satisfies readonly SessionStatus[];
export const INSTRUCTOR_ATT_STATUSES = ['present', 'late', 'absent', 'makeup'] as const satisfies readonly InstructorAttendanceStatus[];
