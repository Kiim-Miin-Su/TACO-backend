export const PROFILE_SELF_DECISION_MIGRATION_ID = '20260715_08_profile_self_decision_super_admin';

// [E0.5 ① 2026-07-15] '자기 결정 금지' DB 방어를 CHECK → 트리거로 교체.
//  배경: 대표(super_admin) 프로필 즉시 적용은 같은 tx에서 decided_by = requester_id로 확정되는데,
//  기존 CHECK(decided_by <> requester_id)는 users.role을 볼 수 없어 이 예외를 표현하지 못했다
//  (PG-mode e2e가 23514로 검출). 트리거가 **비-super_admin의 자기 결정만** 차단해 서비스 403과
//  이중 방어를 유지한다. PROFILE_CHANGE_REQUESTS_SPEC.migrations(부팅 멱등)와 SQL 공유 — 이 스크립트는
//  Neon 장부(schema_migrations) 기록용.
export const PROFILE_SELF_DECISION_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE profile_change_requests DROP CONSTRAINT IF EXISTS profile_change_no_self_decision_check`,
  `CREATE OR REPLACE FUNCTION profile_change_self_decision_guard() RETURNS trigger AS $$
     BEGIN
       IF NEW.decided_by IS NOT NULL AND NEW.decided_by = NEW.requester_id
          AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.requester_id AND role = 'super_admin') THEN
         RAISE EXCEPTION '본인의 프로필 변경 요청은 본인이 처리할 수 없습니다'
           USING ERRCODE = '23514', CONSTRAINT = 'profile_change_no_self_decision_check';
       END IF;
       RETURN NEW;
     END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_profile_change_self_decision ON profile_change_requests`,
  `CREATE TRIGGER trg_profile_change_self_decision
     BEFORE INSERT OR UPDATE ON profile_change_requests
     FOR EACH ROW EXECUTE FUNCTION profile_change_self_decision_guard()`,
];
