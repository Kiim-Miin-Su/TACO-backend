export const SCHEDULE_REQUEST_BATCH_MIGRATION_ID =
  '20260730_04_tbo78_schedule_request_batch_idempotency';

export const SCHEDULE_REQUEST_BATCH_CONSTRAINT =
  'c_schedule_requests_batch_complete';

export const SCHEDULE_REQUEST_BATCH_INDEX =
  'uq_schedule_requests_batch_item';

export const SCHEDULE_REQUEST_BATCH_PREFLIGHT_SQL = `
  DO $$
  BEGIN
    IF to_regclass('public.schedule_requests') IS NULL THEN
      RAISE EXCEPTION 'schedule_requests table is missing';
    END IF;
  END $$`;

export const SCHEDULE_REQUEST_BATCH_MIGRATION_SQL = [
  `ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS batch_key uuid`,
  `ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS batch_fingerprint varchar(64)`,
  `ALTER TABLE schedule_requests ADD COLUMN IF NOT EXISTS batch_index integer`,
  `ALTER TABLE schedule_requests
     ADD CONSTRAINT ${SCHEDULE_REQUEST_BATCH_CONSTRAINT}
     CHECK (
       (batch_key IS NULL AND batch_fingerprint IS NULL AND batch_index IS NULL)
       OR (
         batch_key IS NOT NULL
         AND batch_fingerprint IS NOT NULL
         AND batch_fingerprint ~ '^[a-f0-9]{64}$'
         AND batch_index IS NOT NULL
         AND batch_index >= 0
       )
     ) NOT VALID`,
  `ALTER TABLE schedule_requests VALIDATE CONSTRAINT ${SCHEDULE_REQUEST_BATCH_CONSTRAINT}`,
  `CREATE UNIQUE INDEX ${SCHEDULE_REQUEST_BATCH_INDEX}
     ON schedule_requests (requester_id, batch_key, batch_index)
     WHERE batch_key IS NOT NULL`,
] as const;
