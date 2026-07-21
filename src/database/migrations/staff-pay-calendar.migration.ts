export const STAFF_PAY_CALENDAR_MIGRATION_ID = '20260721_04_tbo36_staff_pay_calendar';

export const TBO36_INSTRUCTOR_PROFILE_SQL: readonly string[] = [
  `ALTER TABLE instructor_profiles ADD COLUMN IF NOT EXISTS default_hourly_rate integer NOT NULL DEFAULT 0`,
  `ALTER TABLE instructor_profiles ADD COLUMN IF NOT EXISTS can_teach_kinder boolean NOT NULL DEFAULT false`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'instructor_profiles_default_hourly_rate_check') THEN
       ALTER TABLE instructor_profiles ADD CONSTRAINT instructor_profiles_default_hourly_rate_check
         CHECK (default_hourly_rate BETWEEN 0 AND 100000000);
     END IF;
   END $$`,
];

export const TBO36_COURSES_SQL: readonly string[] = [
  `ALTER TABLE courses ADD COLUMN IF NOT EXISTS hourly_rate_override integer`,
  `ALTER TABLE courses ADD COLUMN IF NOT EXISTS is_kinder boolean NOT NULL DEFAULT false`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'courses_hourly_rate_override_check') THEN
       ALTER TABLE courses ADD CONSTRAINT courses_hourly_rate_override_check
         CHECK (hourly_rate_override IS NULL OR hourly_rate_override BETWEEN 0 AND 100000000);
     END IF;
   END $$`,
];

export const TBO36_CLASS_SESSIONS_SQL: readonly string[] = [
  `ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_public_date
     ON class_sessions (session_date) WHERE is_public = true AND deleted_at IS NULL`,
];

export const TBO36_STUDENTS_SQL: readonly string[] = [
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'students_grade_check'
         AND (pg_get_constraintdef(oid) NOT LIKE '%grade >= 0%' OR pg_get_constraintdef(oid) NOT LIKE '%grade <= 12%')
     ) THEN
       ALTER TABLE students DROP CONSTRAINT students_grade_check;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_grade_check') THEN
       ALTER TABLE students ADD CONSTRAINT students_grade_check
         CHECK (grade IS NOT NULL AND grade BETWEEN 0 AND 12) NOT VALID;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_birth_date_required') THEN
       ALTER TABLE students ADD CONSTRAINT students_birth_date_required
         CHECK (birth_date IS NOT NULL) NOT VALID;
     END IF;
   END $$`,
];

export const STAFF_PAY_CALENDAR_MIGRATION_SQL: readonly string[] = [
  ...TBO36_INSTRUCTOR_PROFILE_SQL,
  ...TBO36_COURSES_SQL,
  ...TBO36_CLASS_SESSIONS_SQL,
  ...TBO36_STUDENTS_SQL,
];
