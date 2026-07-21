import type { ClassSession } from './schedule.entity';

/**
 * TBO-37: 강사에게 보이는 운영 세션의 단일 술어.
 *
 * - 강사는 JWT sub와 instructorId가 같은 세션만 볼 수 있다.
 * - 상담 세션은 담당자로 배정됐더라도 관리 역할 전용이다.
 * - isPublic은 관리 화면 표시 속성일 뿐 강사 조회 범위를 넓히지 않는다.
 */
export function isSessionVisibleToInstructor(
  session: Pick<ClassSession, 'instructorId' | 'kind'>,
  instructorId: number,
): boolean {
  return Number(session.instructorId) === Number(instructorId) && session.kind !== 'counsel';
}
