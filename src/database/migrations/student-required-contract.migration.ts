export const STUDENT_REQUIRED_CONTRACT_MIGRATION_ID = '20260721_05_tbo36_student_required_contract';

export const STUDENT_REQUIRED_CONTRACT_SQL: readonly string[] = [
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_grade_check') THEN
       ALTER TABLE students VALIDATE CONSTRAINT students_grade_check;
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'students_birth_date_required') THEN
       ALTER TABLE students VALIDATE CONSTRAINT students_birth_date_required;
     END IF;
   END $$`,
  `ALTER TABLE students ALTER COLUMN grade SET NOT NULL`,
  `ALTER TABLE students ALTER COLUMN birth_date SET NOT NULL`,
  `ALTER TABLE students DROP CONSTRAINT IF EXISTS students_birth_date_required`,
];
