export const INSTRUCTOR_CONTRACT_BOUNDS_MIGRATION_ID =
  '20260729_04_tbo77_instructor_contract_bounds';

/** DTO 상한(MAX_COUNT=100000, MAX_AMOUNT=100000000)을 물리 CHECK와 일치시킨다. */
export const INSTRUCTOR_CONTRACT_BOUNDS_SQL: readonly string[] = [
  `DO $$
   DECLARE bad integer;
   BEGIN
     SELECT COUNT(*) INTO bad
       FROM instructor_contracts
      WHERE monthly_hours > 100000 OR hourly_rate > 100000000;
     IF bad > 0 THEN
       RAISE EXCEPTION 'instructor_contracts values exceed DTO bounds % rows', bad;
     END IF;
   END $$`,
  `ALTER TABLE instructor_contracts DROP CONSTRAINT IF EXISTS c_instructor_contract_monthly_hours`,
  `ALTER TABLE instructor_contracts
     ADD CONSTRAINT c_instructor_contract_monthly_hours
     CHECK (monthly_hours BETWEEN 0 AND 100000) NOT VALID`,
  `ALTER TABLE instructor_contracts DROP CONSTRAINT IF EXISTS c_instructor_contract_hourly_rate`,
  `ALTER TABLE instructor_contracts
     ADD CONSTRAINT c_instructor_contract_hourly_rate
     CHECK (hourly_rate BETWEEN 0 AND 100000000) NOT VALID`,
  `ALTER TABLE instructor_contracts VALIDATE CONSTRAINT c_instructor_contract_monthly_hours`,
  `ALTER TABLE instructor_contracts VALIDATE CONSTRAINT c_instructor_contract_hourly_rate`,
];
