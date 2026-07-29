export const ENROLLMENT_PAYOUT_INTEGRITY_MIGRATION_ID =
  '20260730_02_tbo77_enrollment_payout_integrity';

export const ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS = [
  'fk_enrollments_student',
  'fk_enrollments_course',
  'fk_enrollments_counsel',
  'fk_enrollments_instructor',
  'fk_enrollments_deleted_by',
  'fk_payouts_instructor',
  'fk_payouts_deleted_by',
  'fk_class_sessions_enrollment',
  'fk_class_sessions_payout',
  'fk_class_sessions_paid_payout',
  'c_enrollments_status_enum',
  'c_enrollments_dates',
  'c_enrollments_session_counts',
  'c_payouts_status_enum',
  'c_payouts_period',
  'c_payouts_nonnegative',
  'c_payouts_effective_amount',
  'c_payouts_lines_shape',
  'c_payouts_decision_timestamps',
] as const;

export const ENROLLMENT_PAYOUT_INTEGRITY_INDEXES = [
  'idx_enrollments_counsel_card_all',
  'idx_enrollments_instructor_all',
  'idx_enrollments_deleted_by_all',
  'idx_payouts_instructor_all',
  'idx_payouts_deleted_by_all',
  'idx_sessions_enrollment_all',
  'idx_sessions_payout_all',
  'idx_sessions_paid_payout_all',
] as const;

const PAYOUT_DECISION_SQL = `
  CASE status
    WHEN 'pending' THEN
      confirmed_at IS NULL AND paid_at IS NULL AND reversed_at IS NULL
    WHEN 'confirmed' THEN
      confirmed_at IS NOT NULL AND paid_at IS NULL AND reversed_at IS NULL
    WHEN 'paid' THEN
      confirmed_at IS NOT NULL AND paid_at IS NOT NULL AND reversed_at IS NULL
    WHEN 'rejected' THEN
      length(btrim(COALESCE(rejected_reason, ''))) > 0
      AND (
        reversed_at IS NULL
        OR (
          paid_at IS NOT NULL
          AND length(btrim(COALESCE(reversed_reason, ''))) > 0
        )
      )
    ELSE false
  END
`;

export const ENROLLMENT_PAYOUT_INTEGRITY_SQL: readonly string[] = [
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.enrollments') IS NULL
        OR to_regclass('public.instructor_payouts') IS NULL
        OR to_regclass('public.class_sessions') IS NULL THEN
       RAISE EXCEPTION 'enrollments, instructor_payouts and class_sessions tables are required';
     END IF;

     SELECT COUNT(*) INTO bad FROM enrollments e LEFT JOIN students s ON s.id=e.student_id WHERE s.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'enrollments student orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM enrollments e LEFT JOIN courses c ON c.id=e.course_id WHERE c.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'enrollments course orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM enrollments e LEFT JOIN counsel_forms c ON c.id=e.counsel_card_id
      WHERE e.counsel_card_id IS NOT NULL AND c.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'enrollments counsel orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM enrollments e LEFT JOIN users u ON u.id=e.instructor_id
      WHERE e.instructor_id IS NOT NULL AND u.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'enrollments instructor orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM enrollments e LEFT JOIN users u ON u.id=e.deleted_by
      WHERE e.deleted_by IS NOT NULL AND u.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'enrollments deleted_by orphan % rows', bad; END IF;

     SELECT COUNT(*) INTO bad FROM instructor_payouts p LEFT JOIN users u ON u.id=p.instructor_id
      WHERE u.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'instructor_payouts instructor orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM instructor_payouts p LEFT JOIN users u ON u.id=p.deleted_by
      WHERE p.deleted_by IS NOT NULL AND u.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'instructor_payouts deleted_by orphan % rows', bad; END IF;

     SELECT COUNT(*) INTO bad FROM class_sessions s LEFT JOIN enrollments e ON e.id=s.enrollment_id
      WHERE s.enrollment_id IS NOT NULL AND e.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'class_sessions enrollment orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM class_sessions s LEFT JOIN instructor_payouts p ON p.id=s.payout_id
      WHERE s.payout_id IS NOT NULL AND p.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'class_sessions payout orphan % rows', bad; END IF;
     SELECT COUNT(*) INTO bad FROM class_sessions s LEFT JOIN instructor_payouts p ON p.id=s.paid_payout_id
      WHERE s.paid_payout_id IS NOT NULL AND p.id IS NULL;
     IF bad > 0 THEN RAISE EXCEPTION 'class_sessions paid_payout orphan % rows', bad; END IF;

     SELECT COUNT(*) INTO bad FROM enrollments
      WHERE status NOT IN ('active','paused','completed','canceled')
         OR (start_date IS NOT NULL AND end_date IS NOT NULL AND end_date < start_date)
         OR completed_sessions < 0
         OR total_sessions < 0
         OR total_sessions > 1000
         OR (total_sessions IS NOT NULL AND completed_sessions > total_sessions);
     IF bad > 0 THEN RAISE EXCEPTION 'enrollments semantic invariant failed for % rows', bad; END IF;

     SELECT COUNT(*) INTO bad FROM instructor_payouts
      WHERE status NOT IN ('pending','confirmed','paid','rejected')
         OR period_end < period_start
         OR session_count <= 0
         OR total_minutes <= 0
         OR computed_amount < 0
         OR adjusted_amount < 0
         OR amount < 0
         OR amount <> COALESCE(adjusted_amount, computed_amount)
         OR jsonb_typeof(lines::jsonb) <> 'array'
         OR jsonb_array_length(lines::jsonb) <> session_count
         OR NOT (${PAYOUT_DECISION_SQL});
     IF bad > 0 THEN RAISE EXCEPTION 'instructor_payouts semantic invariant failed for % rows', bad; END IF;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.enrollments') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.students') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='fk_enrollments_student') THEN
       ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_student
         FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE RESTRICT NOT VALID;
     END IF;
     IF to_regclass('public.courses') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='fk_enrollments_course') THEN
       ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_course
         FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE RESTRICT NOT VALID;
     END IF;
     IF to_regclass('public.counsel_forms') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='fk_enrollments_counsel') THEN
       ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_counsel
         FOREIGN KEY (counsel_card_id) REFERENCES counsel_forms(id) ON DELETE RESTRICT NOT VALID;
     END IF;
     IF to_regclass('public.users') IS NOT NULL THEN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='fk_enrollments_instructor') THEN
         ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_instructor
           FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='fk_enrollments_deleted_by') THEN
         ALTER TABLE enrollments ADD CONSTRAINT fk_enrollments_deleted_by
           FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
       END IF;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='c_enrollments_status_enum') THEN
       ALTER TABLE enrollments ADD CONSTRAINT c_enrollments_status_enum
         CHECK (status IN ('active','paused','completed','canceled')) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='c_enrollments_dates') THEN
       ALTER TABLE enrollments ADD CONSTRAINT c_enrollments_dates
         CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.enrollments'::regclass AND conname='c_enrollments_session_counts') THEN
       ALTER TABLE enrollments ADD CONSTRAINT c_enrollments_session_counts
         CHECK (
           completed_sessions >= 0
           AND (total_sessions IS NULL OR total_sessions BETWEEN 0 AND 1000)
           AND (total_sessions IS NULL OR completed_sessions <= total_sessions)
         ) NOT VALID;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.instructor_payouts') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.users') IS NOT NULL THEN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='fk_payouts_instructor') THEN
         ALTER TABLE instructor_payouts ADD CONSTRAINT fk_payouts_instructor
           FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='fk_payouts_deleted_by') THEN
         ALTER TABLE instructor_payouts ADD CONSTRAINT fk_payouts_deleted_by
           FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
       END IF;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='c_payouts_status_enum') THEN
       ALTER TABLE instructor_payouts ADD CONSTRAINT c_payouts_status_enum
         CHECK (status IN ('pending','confirmed','paid','rejected')) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='c_payouts_period') THEN
       ALTER TABLE instructor_payouts ADD CONSTRAINT c_payouts_period
         CHECK (period_end >= period_start) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='c_payouts_nonnegative') THEN
       ALTER TABLE instructor_payouts ADD CONSTRAINT c_payouts_nonnegative
         CHECK (
           session_count > 0
           AND total_minutes > 0
           AND computed_amount >= 0
           AND (adjusted_amount IS NULL OR adjusted_amount >= 0)
           AND amount >= 0
         ) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='c_payouts_effective_amount') THEN
       ALTER TABLE instructor_payouts ADD CONSTRAINT c_payouts_effective_amount
         CHECK (
           amount = COALESCE(adjusted_amount, computed_amount)
           AND (adjusted_amount IS NULL OR length(btrim(COALESCE(adjust_reason, ''))) > 0)
         ) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='c_payouts_lines_shape') THEN
       ALTER TABLE instructor_payouts ADD CONSTRAINT c_payouts_lines_shape
         CHECK (
           jsonb_typeof(lines::jsonb) = 'array'
           AND jsonb_array_length(lines::jsonb) = session_count
         ) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.instructor_payouts'::regclass AND conname='c_payouts_decision_timestamps') THEN
       ALTER TABLE instructor_payouts ADD CONSTRAINT c_payouts_decision_timestamps
         CHECK (${PAYOUT_DECISION_SQL}) NOT VALID;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.class_sessions') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.enrollments') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.class_sessions'::regclass AND conname='fk_class_sessions_enrollment') THEN
       ALTER TABLE class_sessions ADD CONSTRAINT fk_class_sessions_enrollment
         FOREIGN KEY (enrollment_id) REFERENCES enrollments(id) ON DELETE RESTRICT NOT VALID;
     END IF;
     IF to_regclass('public.instructor_payouts') IS NOT NULL THEN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.class_sessions'::regclass AND conname='fk_class_sessions_payout') THEN
         ALTER TABLE class_sessions ADD CONSTRAINT fk_class_sessions_payout
           FOREIGN KEY (payout_id) REFERENCES instructor_payouts(id) ON DELETE RESTRICT NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.class_sessions'::regclass AND conname='fk_class_sessions_paid_payout') THEN
         ALTER TABLE class_sessions ADD CONSTRAINT fk_class_sessions_paid_payout
           FOREIGN KEY (paid_payout_id) REFERENCES instructor_payouts(id) ON DELETE RESTRICT NOT VALID;
       END IF;
     END IF;
   END $$`,
  `DO $$
   DECLARE constraint_row record;
   BEGIN
     FOR constraint_row IN
       SELECT conname, conrelid::regclass::text AS table_name
         FROM pg_constraint
        WHERE conname = ANY(ARRAY[${ENROLLMENT_PAYOUT_INTEGRITY_CONSTRAINTS.map((name) => `'${name}'`).join(',')}])
          AND NOT convalidated
     LOOP
       EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', constraint_row.table_name, constraint_row.conname);
     END LOOP;
   END $$`,
];

export const ENROLLMENT_PAYOUT_INTEGRITY_INDEX_SQL: readonly string[] = [
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_enrollments_counsel_card_all ON enrollments (counsel_card_id) WHERE counsel_card_id IS NOT NULL',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_enrollments_instructor_all ON enrollments (instructor_id) WHERE instructor_id IS NOT NULL',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_enrollments_deleted_by_all ON enrollments (deleted_by) WHERE deleted_by IS NOT NULL',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_instructor_all ON instructor_payouts (instructor_id)',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payouts_deleted_by_all ON instructor_payouts (deleted_by) WHERE deleted_by IS NOT NULL',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_enrollment_all ON class_sessions (enrollment_id) WHERE enrollment_id IS NOT NULL',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_payout_all ON class_sessions (payout_id) WHERE payout_id IS NOT NULL',
  'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_paid_payout_all ON class_sessions (paid_payout_id) WHERE paid_payout_id IS NOT NULL',
];
