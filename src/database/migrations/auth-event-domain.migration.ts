export const AUTH_EVENT_DOMAIN_MIGRATION_ID =
  '20260730_07_tbo78_auth_event_domain';

export const AUTH_EVENT_DOMAIN_CONSTRAINT =
  'c_auth_events_event_type_domain';

export const AUTH_EVENT_DOMAIN_SQL = [
  `ALTER TABLE auth_events DROP CONSTRAINT IF EXISTS ${AUTH_EVENT_DOMAIN_CONSTRAINT}`,
  `ALTER TABLE auth_events
     ADD CONSTRAINT ${AUTH_EVENT_DOMAIN_CONSTRAINT}
     CHECK (event_type IN (
       'login_success',
       'login_failure',
       'logout',
       'recover_id_requested',
       'recover_id_completed',
       'password_reset_requested',
       'password_reset_completed',
       'refresh_reuse_blocked',
       'csrf_origin_blocked'
     )) NOT VALID`,
  `ALTER TABLE auth_events VALIDATE CONSTRAINT ${AUTH_EVENT_DOMAIN_CONSTRAINT}`,
] as const;
