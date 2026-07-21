export const COURSE_PAY_SSOT_MIGRATION_ID = '20260721_06_tbo36_course_pay_ssot';

/**
 * Contract migration: courses.hourly_rate was a duplicated effective value.
 * The runner refuses to apply while course rows remain, so this DROP cannot
 * silently discard a rate that has not been classified as profile default or override.
 */
export const COURSE_PAY_SSOT_SQL: readonly string[] = [
  `ALTER TABLE courses DROP COLUMN IF EXISTS hourly_rate`,
];
