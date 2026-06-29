import type { AvailabilityBlock as AvailabilityContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type { AvailabilityOwner, AvailabilityKind } from '@kms545487/contracts';
export type AvailabilityBlock = AvailabilityContract & BaseRow;
export const AVAILABILITY = 'availability_blocks';
