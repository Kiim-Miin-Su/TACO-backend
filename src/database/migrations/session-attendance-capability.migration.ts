import { ROLE_CAPABILITIES } from '@kms545487/contracts';

export const SESSION_ATTENDANCE_CAPABILITY_MIGRATION_ID =
  '20260806_01_tbo86_session_attendance_capability';

const capabilityDomain = ROLE_CAPABILITIES.map((capability) => `'${capability}'`).join(',');

export const SESSION_ATTENDANCE_CAPABILITY_MIGRATION_SQL = [
  `ALTER TABLE user_capability_overrides
     DROP CONSTRAINT IF EXISTS c_user_capability_overrides_capability`,
  `ALTER TABLE user_capability_overrides
     ADD CONSTRAINT c_user_capability_overrides_capability
     CHECK (capability IN (${capabilityDomain})) NOT VALID`,
  `ALTER TABLE user_capability_overrides
     VALIDATE CONSTRAINT c_user_capability_overrides_capability`,
] as const;
