import type { CapabilityOverrideEffect, RoleCapability } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type UserCapabilityOverride = BaseRow & {
  userId: number;
  capability: RoleCapability;
  effect: CapabilityOverrideEffect;
  reason: string;
  createdBy: number;
  updatedBy: number;
};

export const USER_CAPABILITY_OVERRIDES = 'user_capability_overrides';
