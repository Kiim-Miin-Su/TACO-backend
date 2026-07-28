export const COUNSEL_STUDENT_SSOT_CONTRACT_MIGRATION_ID = '20260722_01_tbo38_counsel_student_ssot_contract';

/** Fresh database/runtime-test canonical schema after TBO-38 contract. */
export const COUNSEL_FORMS_CANONICAL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS counsel_forms (
    id serial PRIMARY KEY,
    student_id integer NOT NULL,
    assigned_staff_id integer,
    status varchar(32) NOT NULL DEFAULT 'requested'
      CHECK (status IN ('requested','pending','registered','dropped')),
    source varchar(32) NOT NULL DEFAULT 'manual'
      CHECK (source IN ('internal_form','naver_form','google_form','manual','etc')),
    submitter_type varchar(16) NOT NULL DEFAULT 'unknown'
      CHECK (submitter_type IN ('parent','student','staff','unknown')),
    reference_notes text,
    next_contact_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const STUDENTS_CANONICAL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS students (
    id serial PRIMARY KEY,
    user_id integer,
    mentor_id integer,
    name varchar(50) NOT NULL,
    english_name varchar(50),
    gender varchar(20),
    birth_date date NOT NULL,
    phone varchar(20),
    school_type varchar(32),
    residence_type varchar(32) NOT NULL DEFAULT 'domestic',
    country varchar(8),
    time_zone varchar(64),
    address varchar(100),
    address_detail varchar(100),
    overseas_country varchar(100),
    language_type varchar(32) NOT NULL DEFAULT 'korean',
    level_status varchar(32) NOT NULL DEFAULT 'unknown',
    short_term_goal text,
    long_term_goal text,
    kakao_id varchar(100),
    counsel_topic text,
    status varchar(32) NOT NULL DEFAULT 'new_inquiry',
    memo text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const COUNSEL_STUDENT_SSOT_CONTRACT_SQL: readonly string[] = [
  `ALTER TABLE counsel_forms DROP CONSTRAINT IF EXISTS counsel_forms_parent_fk`,
  `ALTER TABLE counsel_forms DROP CONSTRAINT IF EXISTS counsel_forms_interest_subject_fk`,
  `ALTER TABLE counsel_forms DROP CONSTRAINT IF EXISTS counsel_forms_interest_course_fk`,
  `DROP INDEX IF EXISTS idx_counsel_forms_interest_subject`,
  `ALTER TABLE counsel_forms
     ADD CONSTRAINT counsel_forms_active_student_required
     CHECK (deleted_at IS NOT NULL OR student_id IS NOT NULL) NOT VALID`,
  `ALTER TABLE counsel_forms VALIDATE CONSTRAINT counsel_forms_active_student_required`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS applicant_name`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS applicant_phone`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS parent_id`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS interest_subject_id`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS interest_course_id`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS academy_expectation`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS desired_start_time`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS learning_atmosphere`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS student_intention`,
  `ALTER TABLE counsel_forms DROP COLUMN IF EXISTS weakness`,
  `ALTER TABLE students DROP CONSTRAINT IF EXISTS students_grade_check`,
  `ALTER TABLE students DROP COLUMN IF EXISTS grade`,
  `ALTER TABLE students DROP COLUMN IF EXISTS school_name`,
];
