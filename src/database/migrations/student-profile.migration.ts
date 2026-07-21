export const STUDENT_PROFILE_MIGRATION_ID = '20260721_03_tbo35_student_profile';

export const STUDENT_INTERESTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS student_interests (
    id serial PRIMARY KEY,
    student_id integer NOT NULL,
    course_id integer,
    custom_label varchar(120),
    priority integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer,
    CONSTRAINT student_interests_target_check CHECK (
      (course_id IS NOT NULL) <> (NULLIF(BTRIM(custom_label), '') IS NOT NULL)
    ),
    CONSTRAINT student_interests_priority_check CHECK (priority > 0)
  )`;

export const STUDENT_INTERESTS_FK_SQL = `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_student_interests_student') THEN
       ALTER TABLE student_interests ADD CONSTRAINT fk_student_interests_student
         FOREIGN KEY (student_id) REFERENCES students(id);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_student_interests_course') THEN
       ALTER TABLE student_interests ADD CONSTRAINT fk_student_interests_course
         FOREIGN KEY (course_id) REFERENCES courses(id);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_student_interests_deleted_by') THEN
       ALTER TABLE student_interests ADD CONSTRAINT fk_student_interests_deleted_by
         FOREIGN KEY (deleted_by) REFERENCES users(id);
     END IF;
   END $$`;

export const STUDENT_PROFILE_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS gender varchar(20)`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS birth_date date`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS kakao_id varchar(100)`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS counsel_topic text`,
  `UPDATE students SET status = CASE status
     WHEN 'active' THEN 'enrolled'
     WHEN 'paused' THEN 'on_leave'
     WHEN 'lead' THEN 'new_inquiry'
     WHEN 'completed' THEN 'withdrawn'
     WHEN 'canceled' THEN 'withdrawn'
     ELSE status
   END
   WHERE status IN ('active', 'paused', 'lead', 'completed', 'canceled')`,
  `ALTER TABLE students ALTER COLUMN status SET DEFAULT 'new_inquiry'`,
  `ALTER TABLE students DROP CONSTRAINT IF EXISTS students_status_check`,
  `ALTER TABLE students DROP CONSTRAINT IF EXISTS students_gender_check`,
  `ALTER TABLE students ADD CONSTRAINT students_status_check
     CHECK (status IN ('enrolled', 'on_leave', 'withdrawn', 'registration_lost', 'new_inquiry'))`,
  `ALTER TABLE students ADD CONSTRAINT students_gender_check
     CHECK (gender IS NULL OR gender IN ('male', 'female', 'other', 'undisclosed'))`,
  STUDENT_INTERESTS_TABLE_SQL,
  `CREATE INDEX IF NOT EXISTS idx_student_interests_student
     ON student_interests (student_id, priority) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_interests_student_priority
     ON student_interests (student_id, priority) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_interests_course
     ON student_interests (student_id, course_id) WHERE deleted_at IS NULL AND course_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_interests_custom
     ON student_interests (student_id, LOWER(BTRIM(custom_label)))
     WHERE deleted_at IS NULL AND custom_label IS NOT NULL`,
  STUDENT_INTERESTS_FK_SQL,
];
