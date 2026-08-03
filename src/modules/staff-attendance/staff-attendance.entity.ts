import type { StaffAttendanceRecord as StaffAttendanceContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type StaffAttendanceRecord = StaffAttendanceContract & BaseRow;

export const STAFF_ATTENDANCE_RECORDS = 'staff_attendance_records';

export const STAFF_ATTENDANCE_STATUSES = [
  'present',
  'late',
  'absent',
  'paid_leave',
  'unpaid_leave',
  'sick_leave',
  'remote_work',
] as const;

