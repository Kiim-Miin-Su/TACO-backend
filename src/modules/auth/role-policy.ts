import {
  CAPABILITY_ROLES,
  ROLE_GROUPS,
  roleHasCapability,
  type RoleCapability,
  type StaffRole,
} from '@kms545487/contracts';

export type AppRole = StaffRole;
export type { RoleCapability };
export { CAPABILITY_ROLES, ROLE_GROUPS, roleHasCapability };

export const FINANCE_ROLES: AppRole[] = [...ROLE_GROUPS.executive];
export const ADMIN_ROLES: AppRole[] = [...ROLE_GROUPS.operations];
export const STAFF_ROLES: AppRole[] = [...ROLE_GROUPS.staff];

export const rolesForCapability = (capability: RoleCapability): readonly AppRole[] =>
  CAPABILITY_ROLES[capability];
export const isStaffRole = (role: string): role is AppRole => STAFF_ROLES.includes(role as AppRole);
export const isAdminRole = (role: string): boolean => ADMIN_ROLES.includes(role as AppRole);
export const hasAdminRole = (roles?: readonly string[]): boolean => (roles ?? []).some(isAdminRole);
export const isInstructorOnly = (roles?: readonly string[]): boolean =>
  (roles ?? []).includes('instructor') && !hasAdminRole(roles);
export const claimsHaveCapability = (roles: readonly string[] | undefined, capability: RoleCapability): boolean =>
  (roles ?? []).some((role) => roleHasCapability(role, capability));

/** 가입 신청의 요청 역할은 승인자가 바꿀 수 없다. 역할별 처리 가능 범위만 서버에서 판정한다. */
export const canDecideSignupRole = (actorRole: AppRole, requestedRole: AppRole): boolean => {
  if (requestedRole === 'super_admin') return false;
  if (actorRole === 'super_admin') return true;
  if (actorRole === 'admin') return requestedRole === 'instructor' || requestedRole === 'manager';
  return actorRole === 'manager' && requestedRole === 'instructor';
};
