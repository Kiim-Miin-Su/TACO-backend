import {
  COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID,
  COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL,
} from '../src/database/migrations/counsel-next-contact-datetime.migration';
import {
  COUNSEL_ROUNDS_CANONICAL_TABLE_SQL,
  COUNSEL_ROUNDS_TABLE_SQL,
} from '../src/database/migrations/counsel-persistence.migration';
import { COUNSEL_FORMS_CANONICAL_TABLE_SQL } from '../src/database/migrations/counsel-student-ssot-contract.migration';
import {
  COUNSEL_INSTANT_PATTERN,
  normalizeCounselInstant,
} from '../src/modules/counsel/counsel-instant';

describe('TBO-76 counsel next-contact datetime contract', () => {
  it('canonical forms/rounds schema stores next_contact_at as timestamptz', () => {
    expect(COUNSEL_FORMS_CANONICAL_TABLE_SQL).toContain(
      'next_contact_at timestamptz',
    );
    expect(COUNSEL_ROUNDS_CANONICAL_TABLE_SQL).toContain(
      'next_contact_at timestamptz',
    );
    expect(COUNSEL_ROUNDS_TABLE_SQL).toContain('next_contact_at date');
  });

  it('migration is versioned, KST-explicit, idempotent, and normalizes snapshots', () => {
    const sql = COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL.join('\n');
    expect(COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID).toBe(
      '20260728_02_tbo76_counsel_next_contact_datetime',
    );
    expect(sql).toContain("data_type='date'");
    expect(sql).toContain("AT TIME ZONE 'Asia/Seoul'");
    expect(sql).toContain("form_snapshot->>'nextContactAt'");
  });

  it('accepts timezone-bearing instants and canonicalizes equivalent offsets', () => {
    expect(COUNSEL_INSTANT_PATTERN.test('2026-07-28T09:30:00+09:00')).toBe(true);
    expect(COUNSEL_INSTANT_PATTERN.test('2026-07-28T00:30:00.000Z')).toBe(true);
    expect(COUNSEL_INSTANT_PATTERN.test('2026-07-28')).toBe(false);
    expect(normalizeCounselInstant('2026-07-28T09:30:00+09:00')).toBe(
      '2026-07-28T00:30:00.000Z',
    );
  });
});
