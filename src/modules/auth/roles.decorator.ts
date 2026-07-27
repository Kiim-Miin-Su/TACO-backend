import { SetMetadata } from '@nestjs/common';
import type { AppRole, RoleCapability } from './role-policy';

export {
  ADMIN_ROLES,
  FINANCE_ROLES,
  ROLE_GROUPS,
  STAFF_ROLES,
  claimsHaveCapability,
  hasAdminRole,
  isAdminRole,
  isInstructorOnly,
  type AppRole,
  type RoleCapability,
} from './role-policy';

// 라우트/컨트롤러에 허용 역할을 선언한다. RolesGuard가 이 메타데이터를 읽어 인가를 판단.
// 예) @Roles('super_admin', 'manager', 'admin')  → 셋 중 하나면 통과.
export const ROLES_KEY = 'taco_roles';
export const CAPABILITIES_KEY = 'taco_capabilities';

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
export const RequireCapabilities = (...capabilities: RoleCapability[]) =>
  SetMetadata(CAPABILITIES_KEY, capabilities);
