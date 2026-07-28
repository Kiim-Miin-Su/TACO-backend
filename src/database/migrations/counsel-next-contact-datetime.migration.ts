export const COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_ID =
  '20260728_02_tbo76_counsel_next_contact_datetime';

/**
 * [TBO-76 76A-1] 다음 상담 예정값을 날짜에서 instant로 승격한다.
 * 기존 날짜는 업무 기준인 KST 자정으로 해석하며, 이미 승격된 DB에서는 no-op이다.
 */
export const COUNSEL_NEXT_CONTACT_DATETIME_MIGRATION_SQL: readonly string[] = [
  `DO $$
   BEGIN
     IF to_regclass('public.counsel_forms') IS NULL THEN RETURN; END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='counsel_forms'
          AND column_name='next_contact_at' AND data_type='date'
     ) THEN
       ALTER TABLE counsel_forms
         ALTER COLUMN next_contact_at TYPE timestamptz
         USING (next_contact_at::timestamp AT TIME ZONE 'Asia/Seoul');
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.counsel_rounds') IS NULL THEN RETURN; END IF;
     IF EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='counsel_rounds'
          AND column_name='next_contact_at' AND data_type='date'
     ) THEN
       ALTER TABLE counsel_rounds
         ALTER COLUMN next_contact_at TYPE timestamptz
         USING (next_contact_at::timestamp AT TIME ZONE 'Asia/Seoul');
     END IF;
   END $$`,
  `UPDATE counsel_rounds
      SET form_snapshot = jsonb_set(
        form_snapshot,
        '{nextContactAt}',
        to_jsonb(
          to_char(
            ((form_snapshot->>'nextContactAt')::date::timestamp AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )
      )
    WHERE jsonb_typeof(form_snapshot) = 'object'
      AND form_snapshot->>'nextContactAt' ~ '^\\d{4}-\\d{2}-\\d{2}$'`,
];
