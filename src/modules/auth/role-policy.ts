import type { AccountRole } from '@kms545487/contracts';

export type AppRole = Extract<AccountRole, 'instructor' | 'manager' | 'admin' | 'super_admin'>;
export type RoleCapability =
  | 'staff.login'
  | 'admin.area'
  | 'approval.manage'
  | 'signup.decide'
  | 'finance.access'
  | 'calendar.manage'
  | 'calendar.request-own'
  | 'counsel.manage';

export const ADMIN_ROLES: AppRole[] = ['super_admin', 'manager', 'admin'];
export const STAFF_ROLES: AppRole[] = ['instructor', 'manager', 'admin', 'super_admin'];

const CAPABILITY_ROLES: Record<RoleCapability, readonly AppRole[]> = {
  'staff.login': STAFF_ROLES,
  'admin.area': ADMIN_ROLES,
  'approval.manage': ADMIN_ROLES,
  'signup.decide': ADMIN_ROLES,
  'finance.access': ['super_admin'],
  'calendar.manage': ADMIN_ROLES,
  'calendar.request-own': STAFF_ROLES,
  'counsel.manage': ADMIN_ROLES,
};

export const isStaffRole = (role: string): role is AppRole => STAFF_ROLES.includes(role as AppRole);
export const isAdminRole = (role: string): boolean => ADMIN_ROLES.includes(role as AppRole);
export const hasAdminRole = (roles?: readonly string[]): boolean => (roles ?? []).some(isAdminRole);
export const isInstructorOnly = (roles?: readonly string[]): boolean =>
  (roles ?? []).includes('instructor') && !hasAdminRole(roles);
export const roleHasCapability = (role: string, capability: RoleCapability): boolean =>
  CAPABILITY_ROLES[capability].includes(role as AppRole);

/** 가입 신청의 요청 역할은 승인자가 바꿀 수 없다. 역할별 처리 가능 범위만 서버에서 판정한다. */
export const canDecideSignupRole = (actorRole: AppRole, requestedRole: AppRole): boolean => {
  if (requestedRole === 'super_admin') return false;
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return requestedRole === 'instructor' || requestedRole === 'manager';
  return actorRole === 'manager' && requestedRole === 'instructor';
};
