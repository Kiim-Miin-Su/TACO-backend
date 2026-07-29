import { createHash } from 'crypto';
import type { CreateScheduleRequestInput } from '@kms545487/contracts';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function scheduleRequestBatchFingerprint(
  requesterId: number,
  requests: CreateScheduleRequestInput[],
): string {
  return createHash('sha256')
    .update(canonicalJson({ requesterId, requests }))
    .digest('hex');
}
