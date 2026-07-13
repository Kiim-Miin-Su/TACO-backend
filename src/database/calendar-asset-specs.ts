import type { PostgresCollectionSpec } from './postgres-collection.store';

const activeIndex = (table: string, name: string, columns: string): string =>
  `CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${columns}) WHERE deleted_at IS NULL`;

export const USERS_SPEC: PostgresCollectionSpec = {
  table: 'users',
  createSql: `
    CREATE TABLE IF NOT EXISTS users (
      id serial PRIMARY KEY,
      web_id varchar(50) NOT NULL UNIQUE,
      name varchar(50) NOT NULL,
      email varchar(255) UNIQUE,
      phone varchar(20),
      role varchar(32) NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'pending',
      password_hash varchar(255) NOT NULL,
      email_verified boolean NOT NULL DEFAULT false,
      email_verify_token varchar(64),
      approved_by integer,
      approved_at timestamptz,
      last_login_at timestamptz,
      country_code varchar(8),
      time_zone varchar(64),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  indexes: [
    activeIndex('users', 'idx_users_role', 'role'),
    activeIndex('users', 'idx_users_status', 'status'),
  ],
};

export const STUDENTS_SPEC: PostgresCollectionSpec = {
  table: 'students',
  createSql: `
    CREATE TABLE IF NOT EXISTS students (
      id serial PRIMARY KEY,
      user_id integer,
      mentor_id integer,
      name varchar(50) NOT NULL,
      english_name varchar(50),
      phone varchar(20),
      grade integer,
      school_name varchar(100),
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
      status varchar(32) NOT NULL DEFAULT 'lead',
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  indexes: [
    activeIndex('students', 'idx_students_status', 'status'),
    activeIndex('students', 'idx_students_country', 'country'),
  ],
};

export const SUBJECTS_SPEC: PostgresCollectionSpec = {
  table: 'subjects',
  createSql: `
    CREATE TABLE IF NOT EXISTS subjects (
      id serial PRIMARY KEY,
      code varchar(50) NOT NULL UNIQUE,
      name varchar(50) NOT NULL,
      description text,
      color varchar(9),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
};

export const COURSES_SPEC: PostgresCollectionSpec = {
  table: 'courses',
  createSql: `
    CREATE TABLE IF NOT EXISTS courses (
      id serial PRIMARY KEY,
      code integer UNIQUE,
      instructor_id integer,
      subject_id integer,
      name varchar(100) NOT NULL,
      description text,
      price integer NOT NULL DEFAULT 0,
      hourly_rate integer NOT NULL DEFAULT 0,
      default_session_count integer,
      default_duration_minutes integer,
      status varchar(32) NOT NULL DEFAULT 'active',
      color varchar(32),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  indexes: [
    activeIndex('courses', 'idx_courses_subject', 'subject_id'),
    activeIndex('courses', 'idx_courses_instructor', 'instructor_id'),
  ],
};

export const ROOMS_SPEC: PostgresCollectionSpec = {
  table: 'rooms',
  createSql: `
    CREATE TABLE IF NOT EXISTS rooms (
      id serial PRIMARY KEY,
      name varchar(100) NOT NULL,
      building_id integer,
      capacity integer,
      color varchar(32),
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
};

export const ENROLLMENTS_SPEC: PostgresCollectionSpec = {
  table: 'enrollments',
  createSql: `
    CREATE TABLE IF NOT EXISTS enrollments (
      id serial PRIMARY KEY,
      student_id integer NOT NULL,
      course_id integer NOT NULL,
      counsel_card_id integer,
      instructor_id integer,
      roadmap_id integer,
      status varchar(32) NOT NULL DEFAULT 'active',
      start_date date,
      end_date date,
      total_sessions integer,
      completed_sessions integer NOT NULL DEFAULT 0,
      memo text,
      enrolled_at date NOT NULL DEFAULT CURRENT_DATE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['enrolledAt', 'startDate', 'endDate'],
  indexes: [
    activeIndex('enrollments', 'idx_enrollments_course_status', 'course_id, status'),
    activeIndex('enrollments', 'idx_enrollments_student_status', 'student_id, status'),
  ],
};

export const AVAILABILITY_SPEC: PostgresCollectionSpec = {
  table: 'availability_blocks',
  createSql: `
    CREATE TABLE IF NOT EXISTS availability_blocks (
      id serial PRIMARY KEY,
      owner_type varchar(32) NOT NULL,
      owner_id integer NOT NULL,
      kind varchar(32) NOT NULL DEFAULT 'available',
      weekday integer NOT NULL,
      start_time varchar(5) NOT NULL,
      end_time varchar(5) NOT NULL,
      effective_from date,
      effective_to date,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['effectiveFrom', 'effectiveTo'],
  indexes: [
    activeIndex('availability_blocks', 'idx_avail_owner_weekday', 'owner_type, owner_id, weekday'),
  ],
};

export const VIEW_PRESETS_SPEC: PostgresCollectionSpec = {
  table: 'calendar_view_presets',
  createSql: `
    CREATE TABLE IF NOT EXISTS calendar_view_presets (
      id serial PRIMARY KEY,
      name varchar(40) NOT NULL,
      view varchar(16) NOT NULL DEFAULT 'week',
      period_from date,
      period_to date,
      instructor_ids text NOT NULL DEFAULT '[]',
      student_ids text NOT NULL DEFAULT '[]',
      room_ids text NOT NULL DEFAULT '[]',
      subjects text NOT NULL DEFAULT '[]',
      statuses text NOT NULL DEFAULT '[]',
      kinds text NOT NULL DEFAULT '[]',
      group_only boolean NOT NULL DEFAULT false,
      q varchar(100),
      color_by varchar(16),
      country_code varchar(8),
      pane_country_instructor varchar(8),
      pane_country_student varchar(8),
      mode_filters text NOT NULL DEFAULT '[]',
      kst_fixed boolean NOT NULL DEFAULT true,
      compact_cols boolean NOT NULL DEFAULT false,
      manual_panes text NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  jsonFields: ['instructorIds', 'studentIds', 'roomIds', 'subjects', 'statuses', 'kinds', 'modeFilters', 'manualPanes'],
  dateFields: ['periodFrom', 'periodTo'],
  indexes: [
    'ALTER TABLE calendar_view_presets DROP CONSTRAINT IF EXISTS calendar_view_presets_name_key',
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_view_presets_active_name ON calendar_view_presets (name) WHERE deleted_at IS NULL',
  ],
};

export const AUDIT_LOG_SPEC: PostgresCollectionSpec = {
  table: 'audit_log',
  createSql: `
    CREATE TABLE IF NOT EXISTS audit_log (
      id serial PRIMARY KEY,
      entity varchar(50) NOT NULL,
      entity_id integer NOT NULL,
      action varchar(32) NOT NULL,
      actor_id integer NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      changes text,
      reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  jsonFields: ['changes'],
  timestampFields: ['at'],
  indexes: [
    activeIndex('audit_log', 'idx_audit_entity_id', 'entity, entity_id'),
    activeIndex('audit_log', 'idx_audit_actor_id', 'actor_id'),
    activeIndex('audit_log', 'idx_audit_at', 'at'),
  ],
};

export const ATTENDANCE_SPEC: PostgresCollectionSpec = {
  table: 'attendance',
  createSql: `
    CREATE TABLE IF NOT EXISTS attendance (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      student_id integer NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'present',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  indexes: [
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_session_student ON attendance (session_id, student_id) WHERE deleted_at IS NULL',
    activeIndex('attendance', 'idx_attendance_session', 'session_id'),
    activeIndex('attendance', 'idx_attendance_student', 'student_id'),
  ],
};

export const SESSION_REPORTS_SPEC: PostgresCollectionSpec = {
  table: 'session_reports',
  createSql: `
    CREATE TABLE IF NOT EXISTS session_reports (
      id serial PRIMARY KEY,
      session_id integer NOT NULL,
      student_id integer NOT NULL,
      subject_id integer,
      instructor_id integer NOT NULL,
      content text NOT NULL,
      homework text,
      status varchar(32) NOT NULL DEFAULT 'draft',
      approval_status varchar(32) NOT NULL DEFAULT 'draft',
      submitted_at timestamptz,
      approved_by integer,
      approved_at timestamptz,
      rejected_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  timestampFields: ['submittedAt', 'approvedAt'],
  indexes: [
    "ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS approval_status varchar(32) NOT NULL DEFAULT 'draft'",
    "UPDATE session_reports SET approval_status = CASE WHEN status IN ('approved', 'rejected') THEN status WHEN status = 'submitted' THEN 'submitted' ELSE approval_status END, status = CASE WHEN status = 'approved' THEN 'sent' WHEN status = 'rejected' THEN 'draft' ELSE status END WHERE status IN ('approved', 'rejected') OR (status = 'submitted' AND approval_status = 'draft')",
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_session_reports_session_student ON session_reports (session_id, student_id) WHERE deleted_at IS NULL',
    activeIndex('session_reports', 'idx_reports_session', 'session_id'),
    activeIndex('session_reports', 'idx_reports_instructor_status', 'instructor_id, status'),
    activeIndex('session_reports', 'idx_reports_instructor_approval', 'instructor_id, approval_status'),
  ],
};

export const INSTRUCTOR_CONTRACTS_SPEC: PostgresCollectionSpec = {
  table: 'instructor_contracts',
  createSql: `
    CREATE TABLE IF NOT EXISTS instructor_contracts (
      id serial PRIMARY KEY,
      instructor_id integer NOT NULL,
      monthly_hours integer NOT NULL,
      hourly_rate integer NOT NULL,
      period_start date NOT NULL,
      period_end date,
      active boolean NOT NULL DEFAULT true,
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['periodStart', 'periodEnd'],
  indexes: [
    activeIndex('instructor_contracts', 'idx_instructor_contracts_instructor_active', 'instructor_id, active'),
    activeIndex('instructor_contracts', 'idx_instructor_contracts_period', 'period_start, period_end'),
  ],
};

export const TRANSACTIONS_SPEC: PostgresCollectionSpec = {
  table: 'transactions',
  createSql: `
    CREATE TABLE IF NOT EXISTS transactions (
      id serial PRIMARY KEY,
      direction varchar(16) NOT NULL,
      category varchar(64) NOT NULL,
      label varchar(200) NOT NULL,
      amount integer NOT NULL,
      method varchar(32),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      payment_id integer,
      payout_id integer,
      expense_id integer,
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  timestampFields: ['occurredAt'],
  indexes: [
    activeIndex('transactions', 'idx_tx_dir_occurred', 'direction, occurred_at'),
    activeIndex('transactions', 'idx_tx_category', 'category'),
    activeIndex('transactions', 'idx_tx_occurred', 'occurred_at'),
    activeIndex('transactions', 'idx_tx_payment', 'payment_id'),
    activeIndex('transactions', 'idx_tx_payout', 'payout_id'),
    activeIndex('transactions', 'idx_tx_expense', 'expense_id'),
  ],
};

export const INSTRUCTOR_PAYOUTS_SPEC: PostgresCollectionSpec = {
  table: 'instructor_payouts',
  createSql: `
    CREATE TABLE IF NOT EXISTS instructor_payouts (
      id serial PRIMARY KEY,
      instructor_id integer NOT NULL,
      period_start date NOT NULL,
      period_end date NOT NULL,
      session_count integer NOT NULL DEFAULT 0,
      total_minutes integer NOT NULL DEFAULT 0,
      computed_amount integer NOT NULL DEFAULT 0,
      adjusted_amount integer,
      adjust_reason varchar(200),
      amount integer NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'pending',
      lines text NOT NULL DEFAULT '[]',
      rejected_reason varchar(200),
      confirmed_at timestamptz,
      paid_at timestamptz,
      payment_method varchar(32),
      bank_account varchar(80),
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  jsonFields: ['lines'],
  dateFields: ['periodStart', 'periodEnd'],
  timestampFields: ['confirmedAt', 'paidAt'],
  indexes: [
    activeIndex('instructor_payouts', 'idx_payouts_instructor_period', 'instructor_id, period_start, period_end'),
    activeIndex('instructor_payouts', 'idx_payouts_status', 'status'),
  ],
};
