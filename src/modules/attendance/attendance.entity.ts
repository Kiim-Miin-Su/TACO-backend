import type { Attendance as AttendanceContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

// [참조/처리] 출결 = 수업 1회(session) × 학생(student) 1행. FK 두 개 + (session,student) 유니크.
//  - sessionId → class_sessions.id, studentId → students.id (서비스에서 존재 검증).
//  - 한 쌍당 최대 1행(upsert 의미) → 중복 방지가 참조 무결성의 핵심.
export type { AttendanceStatus } from '@kms545487/contracts';
export type Attendance = AttendanceContract & BaseRow;
export const ATTENDANCE = 'attendance';
