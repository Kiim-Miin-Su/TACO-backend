export const PARENTS_MIGRATION_ID = '20260715_04_parents';

// [TBO-29D D1] parents/parent_student_relations를 Postgres 자산으로 승격 — 지금까지 메모리 전용이라
//  재기동 시 유실됐다(전수 검증 2026-07-15). 런타임 부팅 DDL(스펙)과 SQL 원문을 공유한다.
//  · 활성 (parent_id, student_id) unique — 같은 보호자·학생 중복 연결을 DB가 최종 차단(409의 권위).
//  · 활성 (student_id) WHERE is_primary unique — "학생당 대표 1명" 불변을 DB로 강제
//    (앱의 demotePrimary는 같은 tx에서 선행 강등하므로 non-deferred여도 안전).
//  · FK는 students/parents 존재를 전제 — 부팅 경로는 존재 확인 후에만 추가(DO 블록 멱등).
export const PARENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS parents (
    id serial PRIMARY KEY,
    name varchar(50) NOT NULL,
    phone varchar(20) NOT NULL DEFAULT '',
    kakao_available boolean NOT NULL DEFAULT false,
    web_id varchar(50),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const PARENT_STUDENT_RELATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS parent_student_relations (
    id serial PRIMARY KEY,
    parent_id integer NOT NULL,
    student_id integer NOT NULL,
    relation varchar(20),
    is_payer boolean NOT NULL DEFAULT false,
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const PARENT_RELATION_INDEX_SQL: readonly string[] = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_parent_student_active
     ON parent_student_relations (parent_id, student_id) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_parent_student_primary
     ON parent_student_relations (student_id) WHERE is_primary AND deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_parent_relations_student
     ON parent_student_relations (student_id) WHERE deleted_at IS NULL`,
];

// FK는 참조 대상 존재 시에만(부팅 순서 방어 — ParentsService가 StudentsService 이후 init되지만 이중 방어).
export const PARENT_FK_SQL = `
  DO $$
  BEGIN
    IF to_regclass('public.parents') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_parent_relations_parent') THEN
      ALTER TABLE parent_student_relations
        ADD CONSTRAINT fk_parent_relations_parent FOREIGN KEY (parent_id) REFERENCES parents(id);
    END IF;
    IF to_regclass('public.students') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_parent_relations_student') THEN
      ALTER TABLE parent_student_relations
        ADD CONSTRAINT fk_parent_relations_student FOREIGN KEY (student_id) REFERENCES students(id);
    END IF;
  END $$`;

export const PARENTS_MIGRATION_SQL: readonly string[] = [
  PARENTS_TABLE_SQL,
  PARENT_STUDENT_RELATIONS_TABLE_SQL,
  ...PARENT_RELATION_INDEX_SQL,
  PARENT_FK_SQL,
];
