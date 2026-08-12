export const STAFF_ENGLISH_NAME_MIGRATION_ID =
  '20260812_01_tbo96_staff_english_name';

export const STAFF_ENGLISH_NAME_CHECK = 'c_users_english_name_format';

/**
 * 기존 운영 행은 web_id의 영문 토큰으로 안전 백필한다. 이는 NOT NULL 배포를 위한 대체값이며,
 * 실제 학부모 표기명은 마이 페이지/관리자 수정 경로에서 교정한다.
 */
const ADD_COLUMN_SQL = `ALTER TABLE users ADD COLUMN IF NOT EXISTS english_name varchar(80)`;
const BACKFILL_SQL = `WITH normalized AS (
     SELECT id, btrim(regexp_replace(initcap(regexp_replace(web_id, '[^A-Za-z]+', ' ', 'g')), '[[:space:]]+', ' ', 'g')) AS value
       FROM users
   )
   UPDATE users u
      SET english_name = CASE WHEN n.value <> '' THEN n.value ELSE 'Staff' END
     FROM normalized n
    WHERE u.id=n.id AND (u.english_name IS NULL OR btrim(u.english_name)='')`;
const NORMALIZE_SQL = `UPDATE users SET english_name=regexp_replace(btrim(english_name), '[[:space:]]+', ' ', 'g')
    WHERE english_name IS NOT NULL`;
const ADD_CHECK_SQL = `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname='c_users_english_name_format' AND conrelid='public.users'::regclass
     ) THEN
       ALTER TABLE users ADD CONSTRAINT c_users_english_name_format
         CHECK (
           char_length(english_name) BETWEEN 1 AND 80
           AND english_name=btrim(english_name)
           AND english_name ~ '^[A-Za-z][A-Za-z .''-]*$'
         ) NOT VALID;
     END IF;
   END $$`;
const PROFILE_CHANGE_KEYS_SQL = `DO $$
   BEGIN
     IF to_regclass('public.profile_change_requests') IS NULL THEN RETURN; END IF;
     ALTER TABLE profile_change_requests DROP CONSTRAINT IF EXISTS profile_change_requested_keys_check;
     ALTER TABLE profile_change_requests ADD CONSTRAINT profile_change_requested_keys_check CHECK (
       jsonb_typeof(requested_changes) = 'object'
       AND requested_changes <> '{}'::jsonb
       AND requested_changes - ARRAY['name','englishName','phone','countryCode','timeZone','email','webId'] = '{}'::jsonb
     );
   END $$`;

/** 구버전 backend와 양립하는 expand 단계. nullable 컬럼을 먼저 만들어 무중단 배포를 준비한다. */
export const STAFF_ENGLISH_NAME_EXPAND_SQL: readonly string[] = [
  ADD_COLUMN_SQL,
  BACKFILL_SQL,
  NORMALIZE_SQL,
  ADD_CHECK_SQL,
  `ALTER TABLE users VALIDATE CONSTRAINT c_users_english_name_format`,
  PROFILE_CHANGE_KEYS_SQL,
];

/** 새 backend 배포 뒤 수행하는 contract 단계. 배포 중 유입된 NULL도 다시 백필하고 필수 제약을 닫는다. */
export const STAFF_ENGLISH_NAME_FINALIZE_SQL: readonly string[] = [
  BACKFILL_SQL,
  NORMALIZE_SQL,
  `ALTER TABLE users ALTER COLUMN english_name SET NOT NULL`,
];

export const STAFF_ENGLISH_NAME_MIGRATION_SQL: readonly string[] = [
  ...STAFF_ENGLISH_NAME_EXPAND_SQL,
  ...STAFF_ENGLISH_NAME_FINALIZE_SQL,
];
