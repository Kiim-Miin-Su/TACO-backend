export const COUNSEL_PERSISTENCE_MIGRATION_ID = '20260720_01_tbo33_counsel_persistence';

export const COUNSEL_FORMS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS counsel_forms (
    id serial PRIMARY KEY,
    applicant_name varchar(60) NOT NULL,
    applicant_phone varchar(30),
    parent_id integer,
    student_id integer,
    assigned_staff_id integer,
    status varchar(32) NOT NULL DEFAULT 'requested'
      CHECK (status IN ('requested','pending','registered','dropped')),
    source varchar(32) NOT NULL DEFAULT 'manual'
      CHECK (source IN ('internal_form','naver_form','google_form','manual','etc')),
    interest_subject_id integer,
    interest_course_id integer,
    academy_expectation text,
    desired_start_time varchar(32),
    learning_atmosphere varchar(32),
    student_intention varchar(32),
    weakness text,
    next_contact_at date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const COUNSEL_ROUNDS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS counsel_rounds (
    id serial PRIMARY KEY,
    counsel_form_id integer NOT NULL REFERENCES counsel_forms(id),
    round_no integer NOT NULL CHECK (round_no >= 0),
    counselor_id integer,
    scheduled_at date,
    completed_at date,
    is_completed boolean NOT NULL DEFAULT false,
    summary varchar(300),
    detail text,
    result varchar(32),
    next_action varchar(500),
    next_contact_at date,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const COUNSEL_PERSISTENCE_INDEX_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_counsel_forms_status ON counsel_forms (status) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_counsel_forms_next_contact ON counsel_forms (next_contact_at) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_counsel_forms_assigned_staff ON counsel_forms (assigned_staff_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_counsel_forms_interest_subject ON counsel_forms (interest_subject_id) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_counsel_rounds_form_round_active
     ON counsel_rounds (counsel_form_id, round_no) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_counsel_rounds_counselor ON counsel_rounds (counselor_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_counsel_rounds_next_contact ON counsel_rounds (next_contact_at) WHERE deleted_at IS NULL`,
];

// 참조 대상 테이블이 모두 올라온 뒤 적용하는 운영 migration 전용 FK. 런타임 bootstrap은 테이블 생성
// 순서와 무관하게 시작할 수 있도록 forms의 FK를 서비스 검증으로 먼저 방어한다.
export const COUNSEL_PERSISTENCE_FK_SQL: readonly string[] = [
  `ALTER TABLE counsel_forms ADD CONSTRAINT counsel_forms_parent_fk FOREIGN KEY (parent_id) REFERENCES parents(id)`,
  `ALTER TABLE counsel_forms ADD CONSTRAINT counsel_forms_student_fk FOREIGN KEY (student_id) REFERENCES students(id)`,
  `ALTER TABLE counsel_forms ADD CONSTRAINT counsel_forms_assigned_staff_fk FOREIGN KEY (assigned_staff_id) REFERENCES users(id)`,
  `ALTER TABLE counsel_forms ADD CONSTRAINT counsel_forms_interest_subject_fk FOREIGN KEY (interest_subject_id) REFERENCES subjects(id)`,
  `ALTER TABLE counsel_forms ADD CONSTRAINT counsel_forms_interest_course_fk FOREIGN KEY (interest_course_id) REFERENCES courses(id)`,
  `ALTER TABLE counsel_rounds ADD CONSTRAINT counsel_rounds_counselor_fk FOREIGN KEY (counselor_id) REFERENCES users(id)`,
];

export const COUNSEL_PERSISTENCE_MIGRATION_SQL: readonly string[] = [
  COUNSEL_FORMS_TABLE_SQL,
  COUNSEL_ROUNDS_TABLE_SQL,
  ...COUNSEL_PERSISTENCE_INDEX_SQL,
];
