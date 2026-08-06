export const SESSION_REPORT_REVISIONS_MIGRATION_ID =
  '20260806_04_tbo86_session_report_revisions';

export const SESSION_REPORT_METADATA_CONSTRAINT =
  'c_session_reports_approval_metadata_v1';

export const SESSION_REPORT_REVISIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_report_revisions (
    id serial PRIMARY KEY,
    report_id integer NOT NULL REFERENCES session_reports(id) ON DELETE RESTRICT,
    before_version integer NOT NULL,
    after_version integer NOT NULL,
    before_content text NOT NULL,
    after_content text NOT NULL,
    before_progress_page text,
    after_progress_page text,
    before_homework text,
    after_homework text,
    reason varchar(1000) NOT NULL,
    edited_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    deleted_by integer,
    CONSTRAINT c_session_report_revisions_version_step
      CHECK (before_version > 0 AND after_version = before_version + 1),
    CONSTRAINT c_session_report_revisions_reason_nonblank
      CHECK (length(btrim(reason)) > 0)
  )`;

export const SESSION_REPORT_REVISIONS_SQL: readonly string[] = [
  `ALTER TABLE session_reports ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1`,
  `UPDATE session_reports
      SET rejected_reason = CASE WHEN approval_status='rejected'
                                 THEN COALESCE(NULLIF(btrim(rejected_reason), ''), '사유 미기재')
                                 ELSE NULL END,
          approved_at = CASE WHEN approval_status='approved' THEN COALESCE(approved_at, updated_at, now()) ELSE NULL END,
          approved_by = CASE WHEN approval_status='approved' THEN approved_by ELSE NULL END`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid='public.session_reports'::regclass
          AND conname='${SESSION_REPORT_METADATA_CONSTRAINT}'
     ) THEN
       ALTER TABLE session_reports
         ADD CONSTRAINT ${SESSION_REPORT_METADATA_CONSTRAINT}
         CHECK (
           (approval_status='approved' AND approved_at IS NOT NULL AND rejected_reason IS NULL)
           OR (approval_status='rejected' AND approved_at IS NULL AND approved_by IS NULL AND length(btrim(rejected_reason)) > 0)
           OR (approval_status IN ('draft','submitted') AND approved_at IS NULL AND approved_by IS NULL AND rejected_reason IS NULL)
         ) NOT VALID;
     END IF;
   END $$`,
  `ALTER TABLE session_reports VALIDATE CONSTRAINT ${SESSION_REPORT_METADATA_CONSTRAINT}`,
  SESSION_REPORT_REVISIONS_TABLE_SQL,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_session_report_revisions_report_version
     ON session_report_revisions (report_id, after_version)`,
  `CREATE INDEX IF NOT EXISTS idx_session_report_revisions_report_created
     ON session_report_revisions (report_id, created_at DESC)`,
];
