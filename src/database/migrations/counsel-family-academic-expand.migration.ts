export const COUNSEL_FAMILY_ACADEMIC_EXPAND_MIGRATION_ID = '20260721_07_tbo38_counsel_family_academic_expand';

export const STUDENT_FAMILY_RELATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS student_family_relations (
    id serial PRIMARY KEY,
    student_id_a integer NOT NULL REFERENCES students(id),
    student_id_b integer NOT NULL REFERENCES students(id),
    relation_type varchar(20) NOT NULL,
    relation_label varchar(50),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer REFERENCES users(id),
    CONSTRAINT student_family_pair_order_check CHECK (student_id_a < student_id_b),
    CONSTRAINT student_family_relation_type_check CHECK (relation_type IN ('sibling','other')),
    CONSTRAINT student_family_relation_label_check CHECK (
      (relation_type = 'sibling' AND relation_label IS NULL)
      OR (relation_type = 'other' AND char_length(btrim(relation_label)) BETWEEN 1 AND 50)
    )
  )`;

export const STUDENT_ACADEMIC_HISTORIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS student_academic_histories (
    id serial PRIMARY KEY,
    student_id integer NOT NULL REFERENCES students(id),
    grade smallint NOT NULL CHECK (grade BETWEEN 0 AND 13),
    school_name varchar(100) NOT NULL CHECK (char_length(btrim(school_name)) BETWEEN 1 AND 100),
    started_on date NOT NULL,
    ended_on date,
    changed_by integer NOT NULL REFERENCES users(id),
    changed_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer REFERENCES users(id),
    CONSTRAINT student_academic_period_check CHECK (ended_on IS NULL OR started_on <= ended_on)
  )`;

export const STUDENT_FAMILY_RELATIONS_INDEX_SQL: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_student_family_relations_active_pair
     ON student_family_relations (student_id_a, student_id_b) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_student_family_relations_b
     ON student_family_relations (student_id_b) WHERE deleted_at IS NULL`,
];

export const STUDENT_ACADEMIC_HISTORIES_INDEX_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_student_academic_histories_student_start
     ON student_academic_histories (student_id, started_on) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_student_academic_histories_student_end
     ON student_academic_histories (student_id, ended_on) WHERE deleted_at IS NULL`,
];

export const COUNSEL_FAMILY_ACADEMIC_EXPAND_SQL: readonly string[] = [
  `ALTER TABLE counsel_forms ADD COLUMN IF NOT EXISTS reference_notes text`,
  `ALTER TABLE students DROP CONSTRAINT IF EXISTS students_grade_check`,
  `ALTER TABLE students ADD CONSTRAINT students_grade_check CHECK (grade BETWEEN 0 AND 13) NOT VALID`,
  `ALTER TABLE students VALIDATE CONSTRAINT students_grade_check`,
  STUDENT_FAMILY_RELATIONS_TABLE_SQL,
  STUDENT_ACADEMIC_HISTORIES_TABLE_SQL,
  ...STUDENT_FAMILY_RELATIONS_INDEX_SQL,
  ...STUDENT_ACADEMIC_HISTORIES_INDEX_SQL,
];
