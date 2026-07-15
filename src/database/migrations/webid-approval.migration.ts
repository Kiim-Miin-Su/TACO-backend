export const WEBID_APPROVAL_MIGRATION_ID = '20260715_09_webid_approval';

// [E0 2026-07-15] 아이디(webId) 변경 승인제 — profile_change_requests의 keys CHECK에 webId 편입.
//  즉시 변경(PATCH /users/me/credentials)에서 webId를 분리해 승인센터(대표 결정) 경유로 전환:
//  요청 생성(사유 필수) → 승인 시 unique 재검사(identity lock) + auth_version+1(기존 세션 무효) 한 tx.
//  admin 첫 로그인 rotation은 예외(강제 변경 흐름 유지). DROP+ADD는 IF NOT EXISTS가 없어
//  정의 검사 후 교체하는 멱등 DO 블록 — PROFILE_CHANGE_REQUESTS_SPEC.migrations(부팅)와 SQL 공유,
//  이 스크립트는 Neon 장부(schema_migrations) 기록용.
export const WEBID_APPROVAL_MIGRATION_SQL: readonly string[] = [
  `DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname = 'profile_change_requested_keys_check'
         AND pg_get_constraintdef(oid) NOT LIKE '%webId%'
     ) THEN
       ALTER TABLE profile_change_requests DROP CONSTRAINT profile_change_requested_keys_check;
       ALTER TABLE profile_change_requests ADD CONSTRAINT profile_change_requested_keys_check CHECK (
         jsonb_typeof(requested_changes) = 'object'
         AND requested_changes <> '{}'::jsonb
         AND requested_changes - ARRAY['name','phone','countryCode','timeZone','email','webId'] = '{}'::jsonb
       );
     END IF;
   END $$`,
];
