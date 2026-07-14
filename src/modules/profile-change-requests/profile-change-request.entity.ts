import type { BaseRow } from '../../common/types/base';

export const PROFILE_CHANGE_REQUESTS = 'profile_change_requests';

export type ProfileChangeRequestStatus = 'pending' | 'approved' | 'rejected';
export type ProfileChanges = Partial<{
  name: string;
  phone: string | null;
  countryCode: string | null;
  timeZone: string | null;
}>;

export type ProfileChangeRequest = {
  requesterId: number;
  baseProfileVersion: number;
  beforeValues: ProfileChanges;
  requestedChanges: ProfileChanges;
  reason: string;
  status: ProfileChangeRequestStatus;
  decidedBy?: number | null;
  decidedAt?: string | null;
  rejectionReason?: string | null;
  appliedProfileVersion?: number | null;
} & BaseRow;
