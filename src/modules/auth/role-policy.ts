import type { AccountRole } from '@kms545487/contracts';

export type AppRole = Extract<AccountRole, 'instructor' | 'manager' | 'admin' | 'super_admin'>;
export type RoleCapability =
  | 'staff.login'
  | 'admin.area'
  | 'approval.manage'
  | 'signup.decide'
  | 'finance.access'
  | 'calendar.manage'
  | 'calendar.request-own';

export const ADMIN_ROLES: AppRole[] = ['super_admin', 'manager', 'admin'];
export const STAFF_ROLES: AppRole[] = ['instructor', 'manager', 'admin', 'super_admin'];

const CAPABILITY_ROLES: Record<RoleCapability, readonly AppRole[]> = {
  'staff.login': STAFF_ROLES,
  'admin.area': ADMIN_ROLES,
  'approval.manage': ADMIN_ROLES,
  'signup.decide': ['super_admin'],
  'finance.access': ['super_admin'],
  'calendar.manage': ADMIN_ROLES,
  'calendar.request-own': STAFF_ROLES,
};

export const isStaffRole = (role: string): role is AppRole => STAFF_ROLES.includes(role as AppRole);
export const isAdminRole = (role: string): boolean => ADMIN_ROLES.includes(role as AppRole);
export const hasAdminRole = (roles?: readonly string[]): boolean => (roles ?? []).some(isAdminRole);
export const isInstructorOnly = (roles?: readonly string[]): boolean =>
  (roles ?? []).includes('instructor') && !hasAdminRole(roles);
export const roleHasCapability = (role: string, capability: RoleCapability): boolean =>
  CAPABILITY_ROLES[capability].includes(role as AppRole);
