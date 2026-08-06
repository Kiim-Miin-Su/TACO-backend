export const REMAINING_PERSISTENCE_MIGRATION_ID = '20260720_03_tbo34_remaining_persistence';

export const ROADMAPS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS roadmaps (
    id serial PRIMARY KEY,
    title varchar(100) NOT NULL,
    description text,
    target_grade integer,
    duration_weeks integer,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const ROADMAP_COURSES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS roadmap_courses (
    id serial PRIMARY KEY,
    roadmap_id integer NOT NULL REFERENCES roadmaps(id),
    course_id integer NOT NULL REFERENCES courses(id),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer
  )`;

export const REPORT_TEMPLATES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS report_templates (
    id serial PRIMARY KEY,
    name varchar(40) NOT NULL,
    content text NOT NULL,
    progress_page text,
    homework text,
    owner_user_id integer REFERENCES instructor_profiles(user_id) ON DELETE RESTRICT,
    is_default boolean NOT NULL DEFAULT false,
    is_enforced boolean NOT NULL DEFAULT false,
    created_by integer REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer,
    CONSTRAINT c_report_templates_enforced_global
      CHECK (NOT is_enforced OR owner_user_id IS NULL)
  )`;

export const REMAINING_PERSISTENCE_MIGRATION_SQL = [
  `ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS is_paid boolean NOT NULL DEFAULT false`,
  `ALTER TABLE class_sessions ADD COLUMN IF NOT EXISTS paid_payout_id integer`,
  `DO $$ BEGIN
     IF to_regclass('public.instructor_payouts') IS NOT NULL THEN
       UPDATE class_sessions s
          SET is_paid = true, paid_payout_id = s.payout_id
         FROM instructor_payouts p
        WHERE s.payout_id = p.id AND p.status = 'paid'
          AND (s.is_paid = false OR s.paid_payout_id IS DISTINCT FROM s.payout_id);
     END IF;
   END $$`,
  ROADMAPS_TABLE_SQL,
  ROADMAP_COURSES_TABLE_SQL,
  REPORT_TEMPLATES_TABLE_SQL,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_roadmap_courses_active
     ON roadmap_courses (roadmap_id, course_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_roadmap_courses_roadmap
     ON roadmap_courses (roadmap_id, sort_order) WHERE deleted_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_report_templates_scope_name
     ON report_templates (COALESCE(owner_user_id, 0), name) WHERE deleted_at IS NULL`,
  `INSERT INTO report_templates (id, name, content, homework)
     VALUES
       (1, '정규 수업(기본)', E'오늘 학습 내용: \\n이해도: 상/중/하\\n특이사항: ', '교재 p.   ~   풀이'),
       (2, '시험 대비', E'대비 범위: \\n취약 단원: \\n보강 권장: ', '오답노트 정리')
     ON CONFLICT (id) DO NOTHING`,
  `SELECT setval(pg_get_serial_sequence('report_templates', 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM report_templates), 1), 1), true)`,
] as const;
