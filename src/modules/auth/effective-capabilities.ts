import {
  ROLE_CAPABILITIES,
  isRoleCapability,
  roleHasCapability,
  type RoleCapability,
} from '@kms545487/contracts';

export type CapabilityOverride = {
  capability: string;
  effect: 'allow' | 'deny';
};

/** 역할 기본 정책과 사용자 override를 합성하는 단일 순수 함수. */
export function resolveEffectiveCapabilities(
  roles: readonly string[],
  overrides: readonly CapabilityOverride[],
): RoleCapability[] {
  const effective = new Set<RoleCapability>();
  for (const capability of ROLE_CAPABILITIES) {
    if (roles.some((role) => roleHasCapability(role, capability))) effective.add(capability);
  }
  for (const override of overrides) {
    if (!isRoleCapability(override.capability)) continue;
    if (override.effect === 'allow') effective.add(override.capability);
    else effective.delete(override.capability);
  }
  return ROLE_CAPABILITIES.filter((capability) => effective.has(capability));
}
