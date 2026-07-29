export const SCHEDULE_REQUEST_INTEGRITY_V2_MIGRATION_ID =
  '20260730_03_tbo77_schedule_request_integrity_v2';

export const SCHEDULE_REQUEST_INTEGRITY_V2_CONSTRAINTS = [
  'c_schedule_requests_kind_required_v2',
  'c_schedule_requests_decision_complete_v2',
  'c_schedule_requests_time_semantics_v2',
  'c_schedule_requests_domain_semantics_v2',
] as const;

export const SCHEDULE_REQUEST_INTEGRITY_V2_PREFLIGHT_SQL = `
  DO $$
  DECLARE bad integer;
  BEGIN
    IF to_regclass('public.schedule_requests') IS NULL THEN
      RAISE EXCEPTION 'schedule_requests table is missing';
    END IF;

    SELECT COUNT(*) INTO bad
      FROM schedule_requests
     WHERE NOT (
       CASE request_kind
         WHEN 'session_create' THEN
           course_id IS NOT NULL AND instructor_id IS NOT NULL
           AND session_date IS NOT NULL AND start_time IS NOT NULL
           AND duration_minutes IS NOT NULL
         WHEN 'session_update' THEN
           target_session_id IS NOT NULL AND course_id IS NOT NULL
           AND instructor_id IS NOT NULL AND session_date IS NOT NULL
           AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
           AND scope IS NOT NULL
           AND length(btrim(COALESCE(request_reason, ''))) > 0
         WHEN 'session_delete' THEN
           target_session_id IS NOT NULL AND course_id IS NOT NULL
           AND instructor_id IS NOT NULL AND session_date IS NOT NULL
           AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
           AND scope IS NOT NULL
           AND length(btrim(COALESCE(request_reason, ''))) > 0
         WHEN 'availability_upsert' THEN
           availability_owner_type IS NOT NULL AND availability_owner_id IS NOT NULL
           AND availability_kind IS NOT NULL AND availability_weekday IS NOT NULL
           AND availability_start_time IS NOT NULL AND availability_end_time IS NOT NULL
           AND length(btrim(COALESCE(request_reason, ''))) > 0
         WHEN 'availability_delete' THEN
           target_availability_id IS NOT NULL
           AND availability_owner_type IS NOT NULL AND availability_owner_id IS NOT NULL
           AND availability_kind IS NOT NULL AND availability_weekday IS NOT NULL
           AND availability_start_time IS NOT NULL AND availability_end_time IS NOT NULL
           AND length(btrim(COALESCE(request_reason, ''))) > 0
         ELSE false
       END
     );
    IF bad > 0 THEN
      RAISE EXCEPTION 'schedule_requests v2 kind-required invariant failed for % rows', bad;
    END IF;

    SELECT COUNT(*) INTO bad
      FROM schedule_requests
     WHERE NOT (
       CASE status
         WHEN 'pending' THEN
           decided_by IS NULL AND decided_at IS NULL AND reason IS NULL
           AND created_session_id IS NULL
         WHEN 'approved' THEN
           decided_by IS NOT NULL AND decided_at IS NOT NULL AND reason IS NULL
           AND (
             (request_kind = 'session_create' AND created_session_id IS NOT NULL)
             OR (request_kind <> 'session_create' AND created_session_id IS NULL)
           )
         WHEN 'rejected' THEN
           decided_by IS NOT NULL AND decided_at IS NOT NULL
           AND length(btrim(COALESCE(reason, ''))) > 0
           AND created_session_id IS NULL
         ELSE false
       END
     );
    IF bad > 0 THEN
      RAISE EXCEPTION 'schedule_requests v2 decision invariant failed for % rows', bad;
    END IF;
  END $$`;

const KIND_REQUIRED_SQL = `
  CASE request_kind
    WHEN 'session_create' THEN
      course_id IS NOT NULL AND instructor_id IS NOT NULL
      AND session_date IS NOT NULL AND start_time IS NOT NULL
      AND duration_minutes IS NOT NULL
    WHEN 'session_update' THEN
      target_session_id IS NOT NULL AND course_id IS NOT NULL
      AND instructor_id IS NOT NULL AND session_date IS NOT NULL
      AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
      AND scope IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    WHEN 'session_delete' THEN
      target_session_id IS NOT NULL AND course_id IS NOT NULL
      AND instructor_id IS NOT NULL AND session_date IS NOT NULL
      AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
      AND scope IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    WHEN 'availability_upsert' THEN
      availability_owner_type IS NOT NULL AND availability_owner_id IS NOT NULL
      AND availability_kind IS NOT NULL AND availability_weekday IS NOT NULL
      AND availability_start_time IS NOT NULL AND availability_end_time IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    WHEN 'availability_delete' THEN
      target_availability_id IS NOT NULL
      AND availability_owner_type IS NOT NULL AND availability_owner_id IS NOT NULL
      AND availability_kind IS NOT NULL AND availability_weekday IS NOT NULL
      AND availability_start_time IS NOT NULL AND availability_end_time IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    ELSE false
  END
`;

const DECISION_SQL = `
  CASE status
    WHEN 'pending' THEN
      decided_by IS NULL AND decided_at IS NULL AND reason IS NULL
      AND created_session_id IS NULL
    WHEN 'approved' THEN
      decided_by IS NOT NULL AND decided_at IS NOT NULL AND reason IS NULL
      AND (
        (request_kind = 'session_create' AND created_session_id IS NOT NULL)
        OR (request_kind <> 'session_create' AND created_session_id IS NULL)
      )
    WHEN 'rejected' THEN
      decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND length(btrim(COALESCE(reason, ''))) > 0
      AND created_session_id IS NULL
    ELSE false
  END
`;

const TIME_SEMANTICS_SQL = `
  (request_kind NOT IN ('session_create', 'session_update', 'session_delete')
    OR (
      start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND (end_time IS NULL OR end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      AND duration_minutes BETWEEN 10 AND 480
    ))
  AND
  (request_kind NOT IN ('availability_upsert', 'availability_delete')
    OR (
      availability_weekday BETWEEN 0 AND 6
      AND availability_start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND availability_end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND availability_start_time < availability_end_time
      AND (
        availability_effective_from IS NULL
        OR availability_effective_to IS NULL
        OR availability_effective_to >= availability_effective_from
      )
    ))
`;

const DOMAIN_SEMANTICS_SQL = `
  (kind IS NULL OR kind IN ('class', 'level_test', 'counsel'))
  AND (mode IS NULL OR mode IN ('in_person', 'online'))
  AND (
    request_kind NOT IN ('session_update', 'session_delete')
    OR scope IN ('this', 'this_and_following', 'all')
  )
  AND (
    request_kind NOT IN ('availability_upsert', 'availability_delete')
    OR (
      availability_owner_type IN ('student', 'instructor', 'room')
      AND availability_kind IN ('available', 'unavailable', 'online_only')
    )
  )
  AND (deleted_by IS NULL OR deleted_at IS NOT NULL)
`;

export const SCHEDULE_REQUEST_INTEGRITY_V2_ADD_SQL: readonly string[] = [
  `ALTER TABLE schedule_requests
     ADD CONSTRAINT c_schedule_requests_kind_required_v2
     CHECK (${KIND_REQUIRED_SQL}) NOT VALID`,
  `ALTER TABLE schedule_requests
     ADD CONSTRAINT c_schedule_requests_decision_complete_v2
     CHECK (${DECISION_SQL}) NOT VALID`,
  `ALTER TABLE schedule_requests
     ADD CONSTRAINT c_schedule_requests_time_semantics_v2
     CHECK (${TIME_SEMANTICS_SQL}) NOT VALID`,
  `ALTER TABLE schedule_requests
     ADD CONSTRAINT c_schedule_requests_domain_semantics_v2
     CHECK (${DOMAIN_SEMANTICS_SQL}) NOT VALID`,
];
