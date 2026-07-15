export const SIGNUP_PROFILE_FIELDS_MIGRATION_ID = '20260715_07_signup_profile_fields';

// [E0.5 ④b 2026-07-15] 가입 폼 필드 확장 — 지원자 제공 정보(대학·전공·출생연도)를 users에 보관해
//  승인센터 상세에 표시하고(승인 판단 근거 — 2026-07-15 QA에서 부재 확인), 승인 tx에서
//  instructor_profiles로 승계(COALESCE)한다. 전화는 기존 users.phone 사용.
//  USERS_SPEC.migrations(부팅 멱등 ALTER)와 SQL 공유 — 이 스크립트는 Neon 장부(schema_migrations) 기록용.
export const SIGNUP_PROFILE_FIELDS_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS university varchar(100)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS major varchar(100)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year integer`,
];
