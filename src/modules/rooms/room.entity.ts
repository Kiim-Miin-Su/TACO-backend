import type { Room as RoomContract } from '@kms545487/contracts';
import type { BaseRow } from '../../common/types/base';

export type Room = RoomContract & BaseRow;
export const ROOMS = 'rooms';
