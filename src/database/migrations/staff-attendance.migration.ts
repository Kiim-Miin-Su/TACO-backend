export const STAFF_ATTENDANCE_MIGRATION_ID = '20260803_01_tbo81_staff_attendance';

export const STAFF_ATTENDANCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS staff_attendance_records (
    id serial PRIMARY KEY,
    staff_id integer NOT NULL REFERENCES users(id),
    work_date date NOT NULL,
    status varchar(32) NOT NULL,
    check_in_at timestamptz,
    check_out_at timestamptz,
    memo varchar(500),
    created_by integer NOT NULL REFERENCES users(id),
    updated_by integer NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer REFERENCES users(id),
    CONSTRAINT c_staff_attendance_status CHECK (
      status IN ('present','late','absent','paid_leave','unpaid_leave','sick_leave','remote_work')
    ),
    CONSTRAINT c_staff_attendance_time_pair CHECK (
      (check_in_at IS NULL AND check_out_at IS NULL)
      OR (check_in_at IS NOT NULL AND check_out_at IS NOT NULL AND check_out_at > check_in_at)
    ),
    CONSTRAINT c_staff_attendance_work_window CHECK (
      (check_in_at IS NULL AND check_out_at IS NULL)
      OR (
        (check_in_at AT TIME ZONE 'Asia/Seoul')::date = work_date
        AND check_out_at <= check_in_at + interval '24 hours'
      )
    )
  )
`;

export const STAFF_ATTENDANCE_INDEX_SQL = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_attendance_staff_date_active
     ON staff_attendance_records (staff_id, work_date) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_staff_attendance_date_staff_active
     ON staff_attendance_records (work_date DESC, staff_id) WHERE deleted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_staff_attendance_staff_date_active
     ON staff_attendance_records (staff_id, work_date DESC) WHERE deleted_at IS NULL`,
] as const;

export const STAFF_ATTENDANCE_MIGRATION_SQL = [
  STAFF_ATTENDANCE_TABLE_SQL,
  ...STAFF_ATTENDANCE_INDEX_SQL,
] as const;
