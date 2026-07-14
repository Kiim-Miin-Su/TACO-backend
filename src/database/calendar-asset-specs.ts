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
      email_verify_token_hash varchar(64),
      email_verify_expires_at timestamptz,
      auth_version integer NOT NULL DEFAULT 1,
      must_change_password boolean NOT NULL DEFAULT false,
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
  // [TBO-28B] 기존(Neon) 테이블용 멱등 마이그레이션 — 신규 설치는 createSql이 이미 포함.
  //  email_verify_token(평문)은 v10에서 폐기: 쓰기 중단(hash 컬럼으로 대체), DROP은 후속 마이그레이션.
  migrations: [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token_hash varchar(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires_at timestamptz`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false`,
    `ALTER TABLE users DROP COLUMN IF EXISTS email_verify_token`,
  ],
  indexes: [
    activeIndex('users', 'idx_users_role', 'role'),
    activeIndex('users', 'idx_users_status', 'status'),
  ],
  // [TBO-28A drift 해소] timestamptz 컬럼은 pg 드라이버가 Date로 돌려주므로 ISO string으로 통일.
  //  (createdAt/updatedAt/deletedAt은 store 기본 변환 — 그 외 timestamptz는 여기 선언 필수)
  timestampFields: ['approvedAt', 'lastLoginAt', 'emailVerifyExpiresAt'],
};

// [TBO-28B] 인증 보안 이벤트(append-only) — 업무 audit_log와 분리(erd.dbml auth_events).
//  password/password_hash/JWT/refresh token/raw IP/DB URL 저장 금지(불변식 §5-3).
//  실패 로그인은 user_id 없이 attempted_web_id_hash만. update/remove 경로를 제공하지 않는다.
//  id는 런타임 id 규약(number) 통일을 위해 serial(int) 사용 — dbml bigint 표기는 v10에서 int로 정정.
export const AUTH_EVENTS_SPEC: PostgresCollectionSpec = {
  table: 'auth_events',
  createSql: `
    CREATE TABLE IF NOT EXISTS auth_events (
      id serial PRIMARY KEY,
      event_type varchar(32) NOT NULL,
      user_id integer,
      attempted_web_id_hash varchar(64),
      request_id varchar(64),
      ip_hash varchar(64),
      user_agent varchar(300),
      success boolean NOT NULL,
      failure_code varchar(40),
      at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `,
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_auth_events_user_at ON auth_events (user_id, at)`,
    `CREATE INDEX IF NOT EXISTS idx_auth_events_type_at ON auth_events (event_type, at)`,
  ],
  timestampFields: ['at'],
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
    activeIndex('audit_log', 'idx_audit_entity_id_desc', 'entity, entity_id, id DESC'),
    activeIndex('audit_log', 'idx_audit_actor_id_desc', 'actor_id, id DESC'),
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

export const PAYMENTS_SPEC: PostgresCollectionSpec = {
  table: 'payments',
  createSql: `
    CREATE TABLE IF NOT EXISTS payments (
      id serial PRIMARY KEY,
      enrollment_id integer,
      student_id integer NOT NULL,
      payer_parent_id integer,
      amount integer NOT NULL,
      paid_amount integer NOT NULL DEFAULT 0,
      due_at date,
      paid_at timestamptz,
      status varchar(32) NOT NULL DEFAULT 'pending',
      payment_method varchar(32),
      memo text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['dueAt'],
  timestampFields: ['paidAt'],
  indexes: [
    activeIndex('payments', 'idx_payments_status', 'status'),
    activeIndex('payments', 'idx_payments_student', 'student_id'),
    activeIndex('payments', 'idx_payments_enrollment', 'enrollment_id'),
  ],
};

export const EXPENSES_SPEC: PostgresCollectionSpec = {
  table: 'expenses',
  createSql: `
    CREATE TABLE IF NOT EXISTS expenses (
      id serial PRIMARY KEY,
      category varchar(32) NOT NULL DEFAULT 'supplies',
      title varchar(200) NOT NULL,
      amount integer NOT NULL,
      spent_at date NOT NULL,
      status varchar(32) NOT NULL DEFAULT 'requested',
      paid_by integer,
      payment_method varchar(32),
      vendor varchar(200),
      receipt_url varchar(255),
      memo text,
      rejected_reason varchar(200),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      deleted_by integer
    )
  `,
  dateFields: ['spentAt'],
  indexes: [
    activeIndex('expenses', 'idx_expenses_status', 'status'),
    activeIndex('expenses', 'idx_expenses_spent_at', 'spent_at'),
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
