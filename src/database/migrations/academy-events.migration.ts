export const ACADEMY_EVENTS_MIGRATION_ID = '20260715_05_academy_events';

// [TBO-29D 요구 ⑤⑥] 학원 공통 이벤트(입시 설명회·휴원·모의고사 등)를 Postgres 자산으로 승격 —
//  지금까지 메모리 전용이라 재기동 시 발행분이 유실됐다. 전 직원 조회·매니저 이상 CUD의 권위 저장소.
//  구간 무결성(end_date ≥ start_date)은 CHECK로 DB까지 강제(서비스 400과 이중 방어).
export const ACADEMY_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS academy_events (
    id serial PRIMARY KEY,
    title varchar(100) NOT NULL,
    type varchar(20) NOT NULL CHECK (type IN ('notice','exam','holiday','closure','event')),
    priority varchar(10) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    all_day boolean,
    memo text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer,
    CONSTRAINT academy_events_range_check CHECK (end_date >= start_date)
  )`;

export const ACADEMY_EVENTS_INDEX_SQL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_academy_events_range
     ON academy_events (start_date, end_date) WHERE deleted_at IS NULL`,
];

export const ACADEMY_EVENTS_MIGRATION_SQL: readonly string[] = [
  ACADEMY_EVENTS_TABLE_SQL,
  ...ACADEMY_EVENTS_INDEX_SQL,
];
