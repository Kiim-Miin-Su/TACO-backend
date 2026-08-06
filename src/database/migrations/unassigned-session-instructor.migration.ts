export const UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_ID =
  '20260806_02_tbo86_unassigned_session_instructor';

export const UNASSIGNED_SESSION_INSTRUCTOR_CHECK = `
  instructor_id IS NOT NULL OR (
    status NOT IN ('held','makeup')
    AND instructor_attendance IS NULL
    AND instructor_pay_amount IS NULL
    AND payout_id IS NULL
    AND paid_payout_id IS NULL
    AND is_paid = false
  )
`;

export const UNASSIGNED_SESSION_INSTRUCTOR_MIGRATION_SQL = [
  `ALTER TABLE class_sessions ALTER COLUMN instructor_id DROP NOT NULL`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid='public.class_sessions'::regclass
          AND conname='fk_class_sessions_instructor'
     ) THEN
       ALTER TABLE class_sessions
         ADD CONSTRAINT fk_class_sessions_instructor
         FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE RESTRICT NOT VALID;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid='public.class_sessions'::regclass
          AND conname='c_class_sessions_unassigned_instructor_state'
     ) THEN
       ALTER TABLE class_sessions
         ADD CONSTRAINT c_class_sessions_unassigned_instructor_state
         CHECK (${UNASSIGNED_SESSION_INSTRUCTOR_CHECK}) NOT VALID;
     END IF;
   END $$`,
  `ALTER TABLE class_sessions VALIDATE CONSTRAINT fk_class_sessions_instructor`,
  `ALTER TABLE class_sessions VALIDATE CONSTRAINT c_class_sessions_unassigned_instructor_state`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_assigned_instructor_date
     ON class_sessions (instructor_id, session_date, id)
     WHERE deleted_at IS NULL AND instructor_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_unassigned_date
     ON class_sessions (session_date, start_time, id)
     WHERE deleted_at IS NULL AND instructor_id IS NULL`,
] as const;

export const UNASSIGNED_SESSION_INSTRUCTOR_RUNTIME_SQL = [
  `ALTER TABLE class_sessions ALTER COLUMN instructor_id DROP NOT NULL`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid='public.class_sessions'::regclass
          AND conname='fk_class_sessions_instructor'
     ) THEN
       ALTER TABLE class_sessions
         ADD CONSTRAINT fk_class_sessions_instructor
         FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE RESTRICT;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid='public.class_sessions'::regclass
          AND conname='c_class_sessions_unassigned_instructor_state'
     ) THEN
       ALTER TABLE class_sessions
         ADD CONSTRAINT c_class_sessions_unassigned_instructor_state
         CHECK (${UNASSIGNED_SESSION_INSTRUCTOR_CHECK});
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_assigned_instructor_date
     ON class_sessions (instructor_id, session_date, id)
     WHERE deleted_at IS NULL AND instructor_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_unassigned_date
     ON class_sessions (session_date, start_time, id)
     WHERE deleted_at IS NULL AND instructor_id IS NULL`,
] as const;
