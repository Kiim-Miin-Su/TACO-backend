import type { ClassSession } from './schedule.entity';

/**
 * TBO-37: 강사에게 보이는 운영 세션의 단일 술어.
 *
 * - 강사는 JWT sub와 instructorId가 같은 세션 또는 isPublic 공통 세션을 볼 수 있다.
 * - 상담 세션은 담당자로 배정됐더라도 관리 역할 전용이다.
 * - isPublic은 읽기 범위만 넓히며 생성·수정·삭제 권한은 ADMIN_ROLES 그대로다.
 */
export function isSessionVisibleToInstructor(
  session: Pick<ClassSession, 'instructorId' | 'kind' | 'isPublic'>,
  instructorId: number,
): boolean {
  return session.kind !== 'counsel'
    && (session.isPublic === true || Number(session.instructorId) === Number(instructorId));
}
