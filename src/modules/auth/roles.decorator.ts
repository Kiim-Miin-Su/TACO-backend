import { SetMetadata } from '@nestjs/common';

// 라우트/컨트롤러에 허용 역할을 선언한다. RolesGuard가 이 메타데이터를 읽어 인가를 판단.
// 예) @Roles('super_admin', 'manager', 'admin')  → 셋 중 하나면 통과.
export const ROLES_KEY = 'taco_roles';
export type AppRole = 'instructor' | 'manager' | 'admin' | 'super_admin';

// 관리자급(보고서·수업요청 등 비재무 백오피스 액션)의 공통 집합.
// 돈 관련(payments/expenses/transactions/payouts 전체 관리)은 명시적으로 super_admin만 사용한다.
export const ADMIN_ROLES: AppRole[] = ['super_admin', 'manager', 'admin'];

// 로그인 직원 전체(강사 포함). "로그인만 요구"하는 라우트에 사용 = 인증 필수·역할 무관.
export const STAFF_ROLES: AppRole[] = ['instructor', 'manager', 'admin', 'super_admin'];

export const isAdminRole = (role: string): boolean => (ADMIN_ROLES as string[]).includes(role);
export const hasAdminRole = (roles?: string[]): boolean => (roles ?? []).some(isAdminRole);
export const isInstructorOnly = (roles?: string[]): boolean => (roles ?? []).includes('instructor') && !hasAdminRole(roles);

export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
