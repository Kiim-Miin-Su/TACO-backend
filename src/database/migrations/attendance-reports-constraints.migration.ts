export const ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_ID = '20260728_01_74d1_attendance_reports_constraints';

/**
 * [74D-1 2026-07-28] 출결·리포트 물리 무결성 — CLAUDE §51.3 이행(TBO-74 §74D).
 *  앱 계층(잠금+DB 재조회+CAS+soft delete 동반 전이)의 최후 방어선을 DB가 강제한다:
 *  · FK 7종: attendance(session·student), session_reports(session·student·instructor·approved_by·subject)
 *    — 삭제 정책은 **NO ACTION**(기본): 물리 CASCADE 금지(§51.3 — soft delete 규약이 앱에서 audit와
 *    함께 동반 전이하므로, 물리 DELETE 시도는 자식이 있으면 DB가 차단하는 것이 옳다).
 *    soft-deleted 부모 참조는 FK 위반이 아니다(행이 물리 보존됨) — 앱 규약이 판정(TBO-53과 동일 원칙).
 *  · CHECK 3종: attendance.status(4값 — DTO IsIn과 동일), session_reports.status(3값)·
 *    approval_status(4값 — 계약 유니온과 동일).
 *  · 역방향 index 1종 신설: session_reports.student_id(FK child 대조에서 유일한 공백 —
 *    session_id·instructor_id는 기존 partial index 존재). approved_by·subject_id는 조회 패턴이
 *    없어 **의도적 생략**(과잉 인덱스의 쓰기 비용 회피 — 필요 시 후속, §51.3 대조 결과 기록).
 *  적용 규약: 사전 orphan/invalid RAISE(전수 게이트) → FK/CHECK는 **NOT VALID로 추가 후
 *  VALIDATE CONSTRAINT**(운영 잠금 최소화 — PostgreSQL 17 ALTER TABLE 권고 절차) → 전부 멱등
 *  (conname·convalidated 검사). 표 부재 시 no-op(부팅 순서 무관 — TBO-53 중첩 IF 함정 준수).
 */
export const ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_SQL: readonly string[] = [
  // 0) 사전 게이트 — orphan·invalid status가 하나라도 있으면 적용 중단(RAISE, 교정은 별도 승인 절차).
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.attendance') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.class_sessions') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM attendance a LEFT JOIN class_sessions s ON s.id = a.session_id WHERE s.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'attendance.session_id orphan % rows — repair before adding FK', bad; END IF;
     END IF;
     IF to_regclass('public.students') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM attendance a LEFT JOIN students st ON st.id = a.student_id WHERE st.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'attendance.student_id orphan % rows — repair before adding FK', bad; END IF;
     END IF;
     SELECT COUNT(*) INTO bad FROM attendance WHERE status NOT IN ('present','late','absent','excused');
     IF bad > 0 THEN RAISE EXCEPTION 'attendance.status invalid % rows — repair before adding CHECK', bad; END IF;
   END $$`,
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.session_reports') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.class_sessions') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM session_reports r LEFT JOIN class_sessions s ON s.id = r.session_id WHERE s.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'session_reports.session_id orphan % rows — repair before adding FK', bad; END IF;
     END IF;
     IF to_regclass('public.students') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM session_reports r LEFT JOIN students st ON st.id = r.student_id WHERE st.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'session_reports.student_id orphan % rows — repair before adding FK', bad; END IF;
     END IF;
     IF to_regclass('public.users') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM session_reports r LEFT JOIN users u ON u.id = r.instructor_id WHERE u.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'session_reports.instructor_id orphan % rows — repair before adding FK', bad; END IF;
       SELECT COUNT(*) INTO bad FROM session_reports r LEFT JOIN users u ON u.id = r.approved_by
         WHERE r.approved_by IS NOT NULL AND u.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'session_reports.approved_by orphan % rows — repair before adding FK', bad; END IF;
     END IF;
     IF to_regclass('public.subjects') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM session_reports r LEFT JOIN subjects sb ON sb.id = r.subject_id
         WHERE r.subject_id IS NOT NULL AND sb.id IS NULL;
       IF bad > 0 THEN RAISE EXCEPTION 'session_reports.subject_id orphan % rows — repair before adding FK', bad; END IF;
     END IF;
     SELECT COUNT(*) INTO bad FROM session_reports WHERE status NOT IN ('draft','submitted','sent');
     IF bad > 0 THEN RAISE EXCEPTION 'session_reports.status invalid % rows — repair before adding CHECK', bad; END IF;
     SELECT COUNT(*) INTO bad FROM session_reports WHERE approval_status NOT IN ('draft','submitted','approved','rejected');
     IF bad > 0 THEN RAISE EXCEPTION 'session_reports.approval_status invalid % rows — repair before adding CHECK', bad; END IF;
   END $$`,
  // 1) attendance FK·CHECK — NOT VALID 추가(멱등)
  `DO $$
   BEGIN
     IF to_regclass('public.attendance') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.class_sessions') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_attendance_session') THEN
       ALTER TABLE attendance ADD CONSTRAINT fk_attendance_session
         FOREIGN KEY (session_id) REFERENCES class_sessions(id) NOT VALID;
     END IF;
     IF to_regclass('public.students') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_attendance_student') THEN
       ALTER TABLE attendance ADD CONSTRAINT fk_attendance_student
         FOREIGN KEY (student_id) REFERENCES students(id) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_attendance_status_enum') THEN
       ALTER TABLE attendance ADD CONSTRAINT c_attendance_status_enum
         CHECK (status IN ('present','late','absent','excused')) NOT VALID;
     END IF;
   END $$`,
  // 2) session_reports FK·CHECK — NOT VALID 추가(멱등)
  `DO $$
   BEGIN
     IF to_regclass('public.session_reports') IS NULL THEN RETURN; END IF;
     IF to_regclass('public.class_sessions') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_reports_session') THEN
       ALTER TABLE session_reports ADD CONSTRAINT fk_reports_session
         FOREIGN KEY (session_id) REFERENCES class_sessions(id) NOT VALID;
     END IF;
     IF to_regclass('public.students') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_reports_student') THEN
       ALTER TABLE session_reports ADD CONSTRAINT fk_reports_student
         FOREIGN KEY (student_id) REFERENCES students(id) NOT VALID;
     END IF;
     IF to_regclass('public.users') IS NOT NULL THEN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_reports_instructor') THEN
         ALTER TABLE session_reports ADD CONSTRAINT fk_reports_instructor
           FOREIGN KEY (instructor_id) REFERENCES users(id) NOT VALID;
       END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_reports_approved_by') THEN
         ALTER TABLE session_reports ADD CONSTRAINT fk_reports_approved_by
           FOREIGN KEY (approved_by) REFERENCES users(id) NOT VALID;
       END IF;
     END IF;
     IF to_regclass('public.subjects') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_reports_subject') THEN
       ALTER TABLE session_reports ADD CONSTRAINT fk_reports_subject
         FOREIGN KEY (subject_id) REFERENCES subjects(id) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_reports_status_enum') THEN
       ALTER TABLE session_reports ADD CONSTRAINT c_reports_status_enum
         CHECK (status IN ('draft','submitted','sent')) NOT VALID;
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_reports_approval_status_enum') THEN
       ALTER TABLE session_reports ADD CONSTRAINT c_reports_approval_status_enum
         CHECK (approval_status IN ('draft','submitted','approved','rejected')) NOT VALID;
     END IF;
   END $$`,
  // 3) VALIDATE CONSTRAINT — 전체 스캔 검증(잠금 최소화 2단계). convalidated=false인 것만(멱등).
  `DO $$
   DECLARE c record;
   BEGIN
     FOR c IN SELECT conname, conrelid::regclass::text AS tbl FROM pg_constraint
       WHERE conname IN ('fk_attendance_session','fk_attendance_student','c_attendance_status_enum',
                         'fk_reports_session','fk_reports_student','fk_reports_instructor',
                         'fk_reports_approved_by','fk_reports_subject',
                         'c_reports_status_enum','c_reports_approval_status_enum')
         AND NOT convalidated
     LOOP
       EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', c.tbl, c.conname);
     END LOOP;
   END $$`,
  // 4) FK child 역방향 index 공백 1종 — session_reports.student_id(활성 행 partial — 기존 규약 동일)
  `CREATE INDEX IF NOT EXISTS idx_reports_student ON session_reports (student_id) WHERE deleted_at IS NULL`,
];

/** ledger(20260728_01) 적용용 전체 SQL — 운영(Neon) migrate 스크립트가 이 목록을 순서대로 실행한다. */
export const ATTENDANCE_REPORTS_CONSTRAINTS_LEDGER_SQL: readonly string[] = [
  ...ATTENDANCE_REPORTS_CONSTRAINTS_MIGRATION_SQL,
];
