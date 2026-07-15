export const CLASS_SESSION_SERIES_MIGRATION_ID = '20260715_01_class_session_series';

// [TBO-29C C2] 반복 시리즈 자산화 — 서버 발급 series ID + 규칙/생성자/기간 영속 + class_sessions.series_id FK 승격.
//  설계 근거: TBO-29C-CALENDAR-INTEGRITY.md §3. 회차 snapshot(course/instructor/room/student)은 class_sessions가
//  소유하며 이 표에 복제하지 않는다. weekdays는 text JSON('[1,3,5]') — student_ids/view preset과 동일 규약.
export const CLASS_SESSION_SERIES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS class_session_series (
    id serial PRIMARY KEY,
    repeat_kind varchar(16) NOT NULL DEFAULT 'custom' CHECK (repeat_kind IN ('weekly','custom')),
    weekdays text NOT NULL DEFAULT '[]',
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    start_time varchar(5) NOT NULL,
    duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 10 AND 480),
    time_zone varchar(64) NOT NULL DEFAULT 'Asia/Seoul',
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by integer,
    updated_by integer,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer,
    CONSTRAINT class_session_series_range_check CHECK (starts_on <= ends_on)
  )`;

// 기존 orphan series_id(시리즈 행 없는 회차 그룹) backfill — 회차에서 규칙을 보수적으로 파생(custom).
//  soft-deleted 회차도 포함(FK는 deleted 행에도 적용). 멱등: NOT EXISTS 가드.
export const CLASS_SESSION_SERIES_BACKFILL_SQL = `
  INSERT INTO class_session_series (id, repeat_kind, weekdays, starts_on, ends_on, start_time, duration_minutes, time_zone, version)
  SELECT s.series_id,
         'custom',
         COALESCE(jsonb_agg(DISTINCT EXTRACT(DOW FROM s.session_date)::int), '[]'::jsonb)::text,
         MIN(s.session_date),
         MAX(s.session_date),
         MIN(s.start_time),
         GREATEST(10, LEAST(480, COALESCE(MAX(s.duration_minutes), 60))),
         'Asia/Seoul',
         1
    FROM class_sessions s
   WHERE s.series_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM class_session_series cs WHERE cs.id = s.series_id)
   GROUP BY s.series_id`;

export const CLASS_SESSION_SERIES_SETVAL_SQL = `
  SELECT setval(pg_get_serial_sequence('class_session_series','id'),
                GREATEST((SELECT COALESCE(MAX(id), 1) FROM class_session_series), 1))`;

// FK 승격 — backfill 이후에만 성공한다(orphan이 남아 있으면 명시적으로 실패해 드리프트를 드러낸다).
export const CLASS_SESSIONS_SERIES_FK_SQL = `
  DO $$ BEGIN
    IF to_regclass('public.class_sessions') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_class_sessions_series') THEN
      ALTER TABLE class_sessions
        ADD CONSTRAINT fk_class_sessions_series FOREIGN KEY (series_id) REFERENCES class_session_series(id);
    END IF;
  END $$`;

export const CLASS_SESSION_SERIES_MIGRATION_SQL: readonly string[] = [
  CLASS_SESSION_SERIES_TABLE_SQL,
  `CREATE INDEX IF NOT EXISTS idx_session_series_range ON class_session_series (starts_on, ends_on) WHERE deleted_at IS NULL`,
  CLASS_SESSION_SERIES_BACKFILL_SQL,
  CLASS_SESSION_SERIES_SETVAL_SQL,
  CLASS_SESSIONS_SERIES_FK_SQL,
];
