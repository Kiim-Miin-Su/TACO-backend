// [TBO-86J] §12.2 저장 규약 하드닝 잔여 2종 마감 —
//  ① soft delete partial unique 잔여: users.email·subjects.code가 전체 UNIQUE라 삭제(퇴사/폐기)된
//     행의 값을 재사용할 수 없었다(규약 위반 — "일반 UNIQUE면 삭제행 재사용 차단 사고").
//     활성 행 한정 partial unique index로 교체한다(email은 web_id와 같은 lower() 대소문자 무시).
//  ② 자정 크로스 방어 CHECK: class_sessions.end_time은 NULL(자정 초과=duration 파생) 또는
//     start_time 초과여야 한다(R-9 — end<start 무조건 거부 금지, "IS NULL OR" 형태만 허용).
//  패턴: 표 부재 guard → read-only inventory(위반 시 RAISE·중단) → 동적 구식 UNIQUE 제거 +
//  partial index 생성(멱등) → CHECK NOT VALID → VALIDATE. 전부 재실행 무해.
export const SOFTDELETE_UNIQUE_MIDNIGHT_MIGRATION_ID =
  '20260806_06_tbo86_softdelete_unique_midnight';

export const SOFTDELETE_UNIQUE_INDEXES = [
  'uq_users_active_email_ci',
  'uq_subjects_active_code',
] as const;

export const SESSION_MIDNIGHT_CHECK = 'c_sessions_end_after_start';

export const SOFTDELETE_UNIQUE_MIDNIGHT_SQL: readonly string[] = [
  // ── inventory: 교체 후 partial unique가 즉시 위반될 활성 중복·CHECK 위반 행이 있으면 중단 ──
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.users') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM (
         SELECT lower(email) FROM users
          WHERE deleted_at IS NULL AND email IS NOT NULL
          GROUP BY lower(email) HAVING COUNT(*) > 1
       ) duplicated;
       IF bad > 0 THEN RAISE EXCEPTION 'users active duplicate email(ci) % groups', bad; END IF;
     END IF;
     IF to_regclass('public.subjects') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM (
         SELECT code FROM subjects WHERE deleted_at IS NULL GROUP BY code HAVING COUNT(*) > 1
       ) duplicated;
       IF bad > 0 THEN RAISE EXCEPTION 'subjects active duplicate code % groups', bad; END IF;
     END IF;
     IF to_regclass('public.class_sessions') IS NOT NULL THEN
       SELECT COUNT(*) INTO bad FROM class_sessions
        WHERE end_time IS NOT NULL AND end_time <= start_time;
       IF bad > 0 THEN RAISE EXCEPTION 'class_sessions end_time<=start_time % rows', bad; END IF;
     END IF;
   END $$`,
  // ── users.email: 전체 UNIQUE(자동명 무관 동적 제거) → 활성 한정 lower() partial unique ──
  `DO $$
   DECLARE con record;
   BEGIN
     IF to_regclass('public.users') IS NULL THEN RETURN; END IF;
     FOR con IN
       SELECT c.conname FROM pg_constraint c
        WHERE c.conrelid='public.users'::regclass AND c.contype='u' AND array_length(c.conkey, 1)=1
          AND c.conkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.users'::regclass AND attname='email')
     LOOP
       EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', con.conname);
     END LOOP;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.users') IS NULL THEN RETURN; END IF;
     EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_users_active_email_ci ON users (lower(email)) WHERE deleted_at IS NULL AND email IS NOT NULL';
   END $$`,
  // ── subjects.code: 전체 UNIQUE 동적 제거 → 활성 한정 partial unique ──
  `DO $$
   DECLARE con record;
   BEGIN
     IF to_regclass('public.subjects') IS NULL THEN RETURN; END IF;
     FOR con IN
       SELECT c.conname FROM pg_constraint c
        WHERE c.conrelid='public.subjects'::regclass AND c.contype='u' AND array_length(c.conkey, 1)=1
          AND c.conkey[1]=(SELECT attnum FROM pg_attribute WHERE attrelid='public.subjects'::regclass AND attname='code')
     LOOP
       EXECUTE format('ALTER TABLE subjects DROP CONSTRAINT %I', con.conname);
     END LOOP;
   END $$`,
  `DO $$
   BEGIN
     IF to_regclass('public.subjects') IS NULL THEN RETURN; END IF;
     EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS uq_subjects_active_code ON subjects (code) WHERE deleted_at IS NULL';
   END $$`,
  // ── class_sessions 자정 크로스 방어 CHECK(R-9 보존형) — NOT VALID → VALIDATE ──
  `DO $$
   BEGIN
     IF to_regclass('public.class_sessions') IS NULL THEN RETURN; END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='c_sessions_end_after_start' AND conrelid='public.class_sessions'::regclass) THEN
       ALTER TABLE class_sessions ADD CONSTRAINT c_sessions_end_after_start
         CHECK (end_time IS NULL OR end_time > start_time) NOT VALID;
     END IF;
   END $$`,
  `DO $$
   DECLARE con record;
   BEGIN
     IF to_regclass('public.class_sessions') IS NULL THEN RETURN; END IF;
     FOR con IN
       SELECT conname FROM pg_constraint
        WHERE conrelid='public.class_sessions'::regclass
          AND conname='c_sessions_end_after_start' AND NOT convalidated
     LOOP
       EXECUTE format('ALTER TABLE class_sessions VALIDATE CONSTRAINT %I', con.conname);
     END LOOP;
   END $$`,
];
