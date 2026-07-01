import { SetMetadata } from '@nestjs/common';

// 라우트/컨트롤러에 허용 역할을 선언한다. RolesGuard가 이 메타데이터를 읽어 인가를 판단.
// 예) @Roles('super_admin', 'manager', 'admin')  → 셋 중 하나면 통과.
export const ROLES_KEY = 'taco_roles';
export type AppRole = 'instructor' | 'manager' | 'admin' | 'super_admin';

// 관리자급(승인·지급·정산 등 백오피스 액션)의 공통 집합. 재사용해 표기 일관성 유지.
export const ADMIN_ROLES: AppRole[] = ['super_admin', 'manager', 'admin'];

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
