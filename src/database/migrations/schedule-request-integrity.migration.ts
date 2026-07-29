export const SCHEDULE_REQUEST_INTEGRITY_MIGRATION_ID =
  '20260730_01_tbo77_schedule_request_integrity';

export const SCHEDULE_REQUEST_INTEGRITY_CONSTRAINTS = [
  'fk_schedule_requests_requester',
  'fk_schedule_requests_target_session',
  'fk_schedule_requests_course',
  'fk_schedule_requests_instructor',
  'fk_schedule_requests_room',
  'fk_schedule_requests_target_availability',
  'fk_schedule_requests_decided_by',
  'fk_schedule_requests_created_session',
  'fk_schedule_requests_deleted_by',
  'c_schedule_requests_kind_required',
  'c_schedule_requests_decision_complete',
  'c_schedule_requests_time_semantics',
] as const;

const REQUIRED_KIND_SQL = `
  CASE request_kind
    WHEN 'session_create' THEN
      course_id IS NOT NULL
      AND instructor_id IS NOT NULL
      AND session_date IS NOT NULL
      AND start_time IS NOT NULL
      AND duration_minutes IS NOT NULL
    WHEN 'session_update' THEN
      target_session_id IS NOT NULL
      AND course_id IS NOT NULL
      AND instructor_id IS NOT NULL
      AND session_date IS NOT NULL
      AND start_time IS NOT NULL
      AND duration_minutes IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    WHEN 'session_delete' THEN
      target_session_id IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    WHEN 'availability_upsert' THEN
      availability_owner_type IS NOT NULL
      AND availability_owner_id IS NOT NULL
      AND availability_kind IS NOT NULL
      AND availability_weekday IS NOT NULL
      AND availability_start_time IS NOT NULL
      AND availability_end_time IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    WHEN 'availability_delete' THEN
      target_availability_id IS NOT NULL
      AND length(btrim(COALESCE(request_reason, ''))) > 0
    ELSE false
  END
`;

const DECISION_SQL = `
  CASE status
    WHEN 'pending' THEN
      decided_by IS NULL
      AND decided_at IS NULL
      AND reason IS NULL
      AND created_session_id IS NULL
    WHEN 'approved' THEN
      decided_by IS NOT NULL
      AND decided_at IS NOT NULL
      AND reason IS NULL
      AND (request_kind <> 'session_create' OR created_session_id IS NOT NULL)
    WHEN 'rejected' THEN
      decided_by IS NOT NULL
      AND decided_at IS NOT NULL
      AND length(btrim(COALESCE(reason, ''))) > 0
      AND created_session_id IS NULL
    ELSE false
  END
`;

const TIME_SEMANTICS_SQL = `
  (request_kind NOT IN ('session_create', 'session_update')
    OR (
      start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND (end_time IS NULL OR end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
      AND duration_minutes BETWEEN 10 AND 480
    ))
  AND
  (request_kind <> 'availability_upsert'
    OR (
      availability_owner_type IN ('student', 'instructor', 'room')
      AND availability_kind IN ('available', 'unavailable', 'online_only')
      AND availability_weekday BETWEEN 0 AND 6
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

export const SCHEDULE_REQUEST_INTEGRITY_SQL: readonly string[] = [
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.schedule_requests') IS NULL THEN
       RAISE EXCEPTION 'schedule_requests table is missing';
     END IF;

     SELECT COUNT(*) INTO bad FROM schedule_requests WHERE NOT (${REQUIRED_KIND_SQL});
     IF bad > 0 THEN
       RAISE EXCEPTION 'schedule_requests kind-required invariant failed for % rows', bad;
     END IF;

     SELECT COUNT(*) INTO bad FROM schedule_requests WHERE NOT (${DECISION_SQL});
     IF bad > 0 THEN
       RAISE EXCEPTION 'schedule_requests decision invariant failed for % rows', bad;
     END IF;

     SELECT COUNT(*) INTO bad FROM schedule_requests WHERE NOT (${TIME_SEMANTICS_SQL});
     IF bad > 0 THEN
       RAISE EXCEPTION 'schedule_requests time invariant failed for % rows', bad;
     END IF;

     IF to_regclass('public.users') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM schedule_requests r LEFT JOIN users u ON u.id=r.requester_id
        WHERE u.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'schedule_requests requester orphan % rows', bad; END IF;
       SELECT COUNT(*) INTO bad FROM schedule_requests r LEFT JOIN users u ON u.id=r.instructor_id
        WHERE r.instructor_id IS NOT NULL AND u.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'schedule_requests instructor orphan % rows', bad; END IF;
       SELECT COUNT(*) INTO bad FROM schedule_requests r LEFT JOIN users u ON u.id=r.decided_by
        WHERE r.decided_by IS NOT NULL AND u.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'schedule_requests decider orphan % rows', bad; END IF;
       SELECT COUNT(*) INTO bad FROM schedule_requests r LEFT JOIN users u ON u.id=r.deleted_by
        WHERE r.deleted_by IS NOT NULL AND u.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'schedule_requests deleted_by orphan % rows', bad; END IF;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.schedule_requests') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.users') IS NOT NULL THEN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_requester') THEN
         ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_requester
           FOREIGN KEY (requester_id) REFERENCES users(id) NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_instructor') THEN
         ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_instructor
           FOREIGN KEY (instructor_id) REFERENCES users(id) NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_decided_by') THEN
         ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_decided_by
           FOREIGN KEY (decided_by) REFERENCES users(id) NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_deleted_by') THEN
         ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_deleted_by
           FOREIGN KEY (deleted_by) REFERENCES users(id) NOT VALID;
       END IF;
     END IF;
     IF to_regclass('public.class_sessions') IS NOT NULL THEN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_target_session') THEN
         ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_target_session
           FOREIGN KEY (target_session_id) REFERENCES class_sessions(id) NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_created_session') THEN
         ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_created_session
           FOREIGN KEY (created_session_id) REFERENCES class_sessions(id) NOT VALID;
       END IF;
     END IF;
     IF to_regclass('public.courses') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_course') THEN
       ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_course
         FOREIGN KEY (course_id) REFERENCES courses(id) NOT VALID;
     END IF;
     IF to_regclass('public.rooms') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_room') THEN
       ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_room
         FOREIGN KEY (room_id) REFERENCES rooms(id) NOT VALID;
     END IF;
     IF to_regclass('public.availability_blocks') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='fk_schedule_requests_target_availability') THEN
       ALTER TABLE schedule_requests ADD CONSTRAINT fk_schedule_requests_target_availability
         FOREIGN KEY (target_availability_id) REFERENCES availability_blocks(id) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='c_schedule_requests_kind_required') THEN
       ALTER TABLE schedule_requests ADD CONSTRAINT c_schedule_requests_kind_required
         CHECK (${REQUIRED_KIND_SQL}) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='c_schedule_requests_decision_complete') THEN
       ALTER TABLE schedule_requests ADD CONSTRAINT c_schedule_requests_decision_complete
         CHECK (${DECISION_SQL}) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.schedule_requests'::regclass AND conname='c_schedule_requests_time_semantics') THEN
       ALTER TABLE schedule_requests ADD CONSTRAINT c_schedule_requests_time_semantics
         CHECK (${TIME_SEMANTICS_SQL}) NOT VALID;
     END IF;
   END $$`,
  `DO $$
   DECLARE constraint_row record;
   BEGIN
     FOR constraint_row IN
       SELECT conname, conrelid::regclass::text AS table_name
         FROM pg_constraint
        WHERE conrelid='public.schedule_requests'::regclass
          AND conname = ANY(ARRAY[${SCHEDULE_REQUEST_INTEGRITY_CONSTRAINTS.map((name) => `'${name}'`).join(',')}])
          AND NOT convalidated
     LOOP
       EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', constraint_row.table_name, constraint_row.conname);
     END LOOP;
   END $$`,
];
