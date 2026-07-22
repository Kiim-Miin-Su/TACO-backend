export const ENROLLMENT_COURSE_UNIQUE_MIGRATION_ID = '20260722_03_tbo48_enrollment_course_unique';

/** 과목 text 개설의 enrollment ensure가 DB에서도 학생×강사별 과목 운영 단위 1행으로 수렴하도록 한다. */
export const ENROLLMENT_COURSE_UNIQUE_MIGRATION_SQL: readonly string[] = [
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM enrollments
       WHERE deleted_at IS NULL
       GROUP BY student_id, course_id
       HAVING COUNT(*) > 1
     ) THEN
       RAISE EXCEPTION 'active duplicate enrollments exist for (student_id, course_id)';
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_enrollments_student_course_active
     ON enrollments (student_id, course_id) WHERE deleted_at IS NULL`,
];
