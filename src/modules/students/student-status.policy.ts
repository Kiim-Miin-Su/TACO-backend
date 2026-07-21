import type { StudentStatus } from '@kms545487/contracts';

// 퇴원·등록이탈은 이력 조회 대상이지만 신규 배정/가용성/캘린더 resource 대상은 아니다.
// 신규접수는 상담 직후 일정 배정이 가능해야 하므로 반드시 포함한다.
const SCHEDULE_VISIBLE_STATUSES: ReadonlySet<StudentStatus> = new Set([
  'enrolled',
  'on_leave',
  'new_inquiry',
]);

export const isScheduleVisibleStudentStatus = (status: StudentStatus): boolean =>
  SCHEDULE_VISIBLE_STATUSES.has(status);
