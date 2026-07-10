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
      name varchar(40) NOT NULL UNIQUE,
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
