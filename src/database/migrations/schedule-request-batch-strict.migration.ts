export const SCHEDULE_REQUEST_BATCH_STRICT_MIGRATION_ID =
  '20260730_05_tbo78_schedule_request_batch_strict';

export const SCHEDULE_REQUEST_BATCH_STRICT_CONSTRAINT =
  'c_schedule_requests_batch_complete';

export const SCHEDULE_REQUEST_BATCH_STRICT_PREFLIGHT_SQL = `
  DO $$
  DECLARE bad integer;
  BEGIN
    SELECT COUNT(*) INTO bad
      FROM schedule_requests
     WHERE NOT (
       (batch_key IS NULL AND batch_fingerprint IS NULL AND batch_index IS NULL)
       OR (
         batch_key IS NOT NULL
         AND batch_fingerprint IS NOT NULL
         AND batch_fingerprint ~ '^[a-f0-9]{64}$'
         AND batch_index IS NOT NULL
         AND batch_index >= 0
       )
     );
    IF bad > 0 THEN
      RAISE EXCEPTION 'schedule request batch strict preflight failed for % rows', bad;
    END IF;
  END $$`;

export const SCHEDULE_REQUEST_BATCH_STRICT_SQL = [
  `ALTER TABLE schedule_requests
     DROP CONSTRAINT IF EXISTS ${SCHEDULE_REQUEST_BATCH_STRICT_CONSTRAINT}`,
  `ALTER TABLE schedule_requests
     ADD CONSTRAINT ${SCHEDULE_REQUEST_BATCH_STRICT_CONSTRAINT}
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
  `ALTER TABLE schedule_requests
     VALIDATE CONSTRAINT ${SCHEDULE_REQUEST_BATCH_STRICT_CONSTRAINT}`,
] as const;
