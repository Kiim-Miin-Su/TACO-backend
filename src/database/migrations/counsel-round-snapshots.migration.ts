export const COUNSEL_ROUND_SNAPSHOTS_MIGRATION_ID = '20260721_02_tbo34_counsel_round_snapshots';

const snapshotExpression = `jsonb_build_object(
  'applicantName', f.applicant_name,
  'applicantPhone', f.applicant_phone,
  'parentId', f.parent_id,
  'studentId', f.student_id,
  'assignedStaffId', f.assigned_staff_id,
  'status', f.status,
  'source', f.source,
  'submitterType', f.submitter_type,
  'interestSubjectId', f.interest_subject_id,
  'interestCourseId', f.interest_course_id,
  'academyExpectation', f.academy_expectation,
  'desiredStartTime', f.desired_start_time,
  'learningAtmosphere', f.learning_atmosphere,
  'studentIntention', f.student_intention,
  'weakness', f.weakness,
  'nextContactAt', COALESCE(r.next_contact_at, f.next_contact_at)
)`;

export const COUNSEL_ROUND_SNAPSHOTS_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE counsel_rounds ADD COLUMN IF NOT EXISTS form_snapshot jsonb`,
  `UPDATE counsel_rounds r
     SET form_snapshot = ${snapshotExpression}
    FROM counsel_forms f
   WHERE f.id = r.counsel_form_id
     AND (r.form_snapshot IS NULL OR r.form_snapshot = '{}'::jsonb)`,
  `ALTER TABLE counsel_rounds ALTER COLUMN form_snapshot SET NOT NULL`,
  `ALTER TABLE counsel_rounds ALTER COLUMN form_snapshot SET DEFAULT '{}'::jsonb`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid='public.counsel_rounds'::regclass
         AND conname='counsel_rounds_form_snapshot_object_check'
     ) THEN
       ALTER TABLE counsel_rounds
         ADD CONSTRAINT counsel_rounds_form_snapshot_object_check
         CHECK (jsonb_typeof(form_snapshot) = 'object');
     END IF;
  END $$`,
];

// Runtime bootstrap은 versioned backfill을 재실행하지 않는다. contract migration 이후에도 필요한
// schema repair만 현재 counsel SSOT 컬럼으로 수행해 local/test 기존 DB를 안전하게 올린다.
const runtimeSnapshotExpression = `jsonb_build_object(
  'studentId', f.student_id,
  'assignedStaffId', f.assigned_staff_id,
  'status', f.status,
  'source', f.source,
  'submitterType', f.submitter_type,
  'referenceNotes', f.reference_notes,
  'nextContactAt', COALESCE(r.next_contact_at, f.next_contact_at)
)`;

export const COUNSEL_ROUND_SNAPSHOTS_RUNTIME_SQL: readonly string[] = [
  COUNSEL_ROUND_SNAPSHOTS_MIGRATION_SQL[0],
  `UPDATE counsel_rounds r
      SET form_snapshot = ${runtimeSnapshotExpression}
     FROM counsel_forms f
    WHERE f.id = r.counsel_form_id
      AND (r.form_snapshot IS NULL OR r.form_snapshot = '{}'::jsonb)`,
  ...COUNSEL_ROUND_SNAPSHOTS_MIGRATION_SQL.slice(2),
];
