// [TBO-77 E-2] enrollments.roadmap_id는 선택값이지만, 값이 있으면 영속 roadmaps 원부를
// 반드시 참조한다. roadmap-course 포함 관계는 soft-delete를 고려해 command/integrity
// 검사에서 강제하고, 물리 FK는 로드맵 본체 고아를 차단한다.
export const ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_ID =
  '20260729_07_tbo77_enrollment_roadmap_integrity';

export const ENROLLMENT_ROADMAP_INTEGRITY_MIGRATION_SQL: readonly string[] = [
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1
         FROM enrollments e
         LEFT JOIN roadmaps r ON r.id = e.roadmap_id
        WHERE e.roadmap_id IS NOT NULL AND r.id IS NULL
     ) THEN
       RAISE EXCEPTION 'orphan enrollments.roadmap_id rows exist';
     END IF;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint WHERE conname = 'fk_enrollments_roadmap'
     ) THEN
       ALTER TABLE enrollments
         ADD CONSTRAINT fk_enrollments_roadmap
         FOREIGN KEY (roadmap_id) REFERENCES roadmaps(id) ON DELETE RESTRICT NOT VALID;
     END IF;
   END $$`,
  `ALTER TABLE enrollments VALIDATE CONSTRAINT fk_enrollments_roadmap`,
  `CREATE INDEX IF NOT EXISTS idx_enrollments_roadmap_active
     ON enrollments (roadmap_id, course_id) WHERE deleted_at IS NULL AND roadmap_id IS NOT NULL`,
];
