export const SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_MIGRATION_ID =
  '20260806_03_tbo86_schedule_request_attendance_correction';

export const SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_CONSTRAINTS = [
  'c_schedule_requests_request_kind_domain_v3',
  'c_schedule_requests_kind_required_v3',
] as const;

export const SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_INDEX =
  'uq_schedule_requests_pending_attendance_correction';

const REQUEST_KINDS = [
  'session_create',
  'session_update',
  'session_delete',
  'availability_upsert',
  'availability_delete',
  'instructor_attendance_correction',
] as const;

const sqlList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

const ATTENDANCE_STATUSES = ['present', 'late', 'absent', 'makeup'] as const;

export const SCHEDULE_REQUEST_KIND_REQUIRED_V3_SQL = `
  CASE request_kind
    WHEN 'session_create' THEN
      course_id IS NOT NULL AND instructor_id IS NOT NULL
      AND session_date IS NOT NULL AND start_time IS NOT NULL
      AND duration_minutes IS NOT NULL
      AND instructor_attendance_before IS NULL AND requested_instructor_attendance IS NULL
    WHEN 'session_update' THEN
      target_session_id IS NOT NULL AND course_id IS NOT NULL
      AND instructor_id IS NOT NULL AND session_date IS NOT NULL
      AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
      AND scope IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
      AND instructor_attendance_before IS NULL AND requested_instructor_attendance IS NULL
    WHEN 'session_delete' THEN
      target_session_id IS NOT NULL AND course_id IS NOT NULL
      AND instructor_id IS NOT NULL AND session_date IS NOT NULL
      AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
      AND scope IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
      AND instructor_attendance_before IS NULL AND requested_instructor_attendance IS NULL
    WHEN 'availability_upsert' THEN
      availability_owner_type IS NOT NULL AND availability_owner_id IS NOT NULL
      AND availability_kind IS NOT NULL AND availability_weekday IS NOT NULL
      AND availability_start_time IS NOT NULL AND availability_end_time IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
      AND instructor_attendance_before IS NULL AND requested_instructor_attendance IS NULL
    WHEN 'availability_delete' THEN
      target_availability_id IS NOT NULL
      AND availability_owner_type IS NOT NULL AND availability_owner_id IS NOT NULL
      AND availability_kind IS NOT NULL AND availability_weekday IS NOT NULL
      AND availability_start_time IS NOT NULL AND availability_end_time IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
      AND instructor_attendance_before IS NULL AND requested_instructor_attendance IS NULL
    WHEN 'instructor_attendance_correction' THEN
      target_session_id IS NOT NULL AND course_id IS NOT NULL
      AND instructor_id IS NOT NULL AND requester_id = instructor_id
      AND session_date IS NOT NULL AND start_time IS NOT NULL AND duration_minutes IS NOT NULL
      AND requested_instructor_attendance IN (${sqlList(ATTENDANCE_STATUSES)})
      AND (instructor_attendance_before IS NULL OR instructor_attendance_before IN (${sqlList(ATTENDANCE_STATUSES)}))
      AND requested_instructor_attendance IS DISTINCT FROM instructor_attendance_before
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    ELSE false
  END
`;

const REPLACE_KIND_CONSTRAINTS_SQL = `
  DO $$
  BEGIN
    ALTER TABLE schedule_requests DROP CONSTRAINT IF EXISTS schedule_requests_request_kind_check;
    ALTER TABLE schedule_requests DROP CONSTRAINT IF EXISTS c_schedule_requests_kind_required;
    ALTER TABLE schedule_requests DROP CONSTRAINT IF EXISTS c_schedule_requests_kind_required_v2;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid='public.schedule_requests'::regclass
         AND conname='c_schedule_requests_request_kind_domain_v3'
    ) THEN
      ALTER TABLE schedule_requests
        ADD CONSTRAINT c_schedule_requests_request_kind_domain_v3
        CHECK (request_kind IN (${sqlList(REQUEST_KINDS)})) NOT VALID;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid='public.schedule_requests'::regclass
         AND conname='c_schedule_requests_kind_required_v3'
    ) THEN
      ALTER TABLE schedule_requests
        ADD CONSTRAINT c_schedule_requests_kind_required_v3
        CHECK (${SCHEDULE_REQUEST_KIND_REQUIRED_V3_SQL}) NOT VALID;
    END IF;
  END $$
`;

export const SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_SQL = [
  `ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS instructor_attendance_before varchar(32)`,
  `ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS requested_instructor_attendance varchar(32)`,
  REPLACE_KIND_CONSTRAINTS_SQL,
  `ALTER TABLE schedule_requests VALIDATE CONSTRAINT c_schedule_requests_request_kind_domain_v3`,
  `ALTER TABLE schedule_requests VALIDATE CONSTRAINT c_schedule_requests_kind_required_v3`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_INDEX}
     ON schedule_requests (requester_id, target_session_id)
     WHERE deleted_at IS NULL AND status='pending'
       AND request_kind='instructor_attendance_correction'`,
] as const;

export const SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_RUNTIME_SQL =
  SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_SQL;
