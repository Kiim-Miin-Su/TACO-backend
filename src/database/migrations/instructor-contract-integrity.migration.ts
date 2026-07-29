export const INSTRUCTOR_CONTRACT_INTEGRITY_MIGRATION_ID =
  '20260729_03_tbo77_instructor_contract_integrity';

export const INSTRUCTOR_CONTRACT_CONSTRAINTS = [
  'fk_instructor_contract_profile',
  'c_instructor_contract_monthly_hours',
  'c_instructor_contract_hourly_rate',
  'c_instructor_contract_period',
  'ex_instructor_contract_active_period',
] as const;

/** 강사 계약의 물리 무결성. 앱 advisory lock과 DB 제약이 기간 경합을 이중 방어한다. */
export const INSTRUCTOR_CONTRACT_INTEGRITY_SQL: readonly string[] = [
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.instructor_contracts') IS NULL THEN
       RAISE EXCEPTION 'instructor_contracts table is missing';
     END IF;
     IF to_regclass('public.instructor_profiles') IS NULL THEN
       RAISE EXCEPTION 'instructor_profiles table is missing';
     END IF;
     SELECT COUNT(*) INTO bad
       FROM instructor_contracts contract
       LEFT JOIN instructor_profiles instructor ON instructor.user_id = contract.instructor_id
      WHERE instructor.user_id IS NULL;
     IF bad > 0 THEN
       RAISE EXCEPTION 'instructor_contracts invalid instructor % rows', bad;
     END IF;
     SELECT COUNT(*) INTO bad
       FROM instructor_contracts
      WHERE monthly_hours < 0
         OR hourly_rate < 0
         OR (period_end IS NOT NULL AND period_end < period_start);
     IF bad > 0 THEN
       RAISE EXCEPTION 'instructor_contracts invalid values % rows', bad;
     END IF;
     SELECT COUNT(*) INTO bad
       FROM instructor_contracts left_contract
       JOIN instructor_contracts right_contract
         ON left_contract.id < right_contract.id
        AND left_contract.instructor_id = right_contract.instructor_id
        AND daterange(left_contract.period_start, COALESCE(left_contract.period_end, 'infinity'::date), '[]')
            && daterange(right_contract.period_start, COALESCE(right_contract.period_end, 'infinity'::date), '[]')
      WHERE left_contract.active
        AND right_contract.active
        AND left_contract.deleted_at IS NULL
        AND right_contract.deleted_at IS NULL;
     IF bad > 0 THEN
       RAISE EXCEPTION 'instructor_contracts overlapping active periods % pairs', bad;
     END IF;
   END $$`,
  `CREATE EXTENSION IF NOT EXISTS btree_gist`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_instructor_contract_profile' AND conrelid='public.instructor_contracts'::regclass) THEN
       ALTER TABLE instructor_contracts ADD CONSTRAINT fk_instructor_contract_profile FOREIGN KEY (instructor_id) REFERENCES instructor_profiles(user_id) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_instructor_contract_monthly_hours' AND conrelid='public.instructor_contracts'::regclass) THEN
       ALTER TABLE instructor_contracts ADD CONSTRAINT c_instructor_contract_monthly_hours CHECK (monthly_hours >= 0) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_instructor_contract_hourly_rate' AND conrelid='public.instructor_contracts'::regclass) THEN
       ALTER TABLE instructor_contracts ADD CONSTRAINT c_instructor_contract_hourly_rate CHECK (hourly_rate >= 0) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_instructor_contract_period' AND conrelid='public.instructor_contracts'::regclass) THEN
       ALTER TABLE instructor_contracts ADD CONSTRAINT c_instructor_contract_period CHECK (period_end IS NULL OR period_end >= period_start) NOT VALID;
     END IF;
   END $$`,
  `DO $$
   DECLARE constraint_row record;
   BEGIN
     FOR constraint_row IN
       SELECT conname
         FROM pg_constraint
        WHERE conrelid='public.instructor_contracts'::regclass
          AND conname IN ('fk_instructor_contract_profile', 'c_instructor_contract_monthly_hours', 'c_instructor_contract_hourly_rate', 'c_instructor_contract_period')
          AND NOT convalidated
     LOOP
       EXECUTE format('ALTER TABLE instructor_contracts VALIDATE CONSTRAINT %I', constraint_row.conname);
     END LOOP;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ex_instructor_contract_active_period' AND conrelid='public.instructor_contracts'::regclass) THEN
       ALTER TABLE instructor_contracts
         ADD CONSTRAINT ex_instructor_contract_active_period
         EXCLUDE USING gist (
           instructor_id WITH =,
           daterange(period_start, COALESCE(period_end, 'infinity'::date), '[]') WITH &&
         )
         WHERE (active AND deleted_at IS NULL);
     END IF;
   END $$`,
];
