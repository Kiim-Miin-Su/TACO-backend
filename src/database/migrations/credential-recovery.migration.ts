export const CREDENTIAL_RECOVERY_MIGRATION_ID = '20260715_02_credential_recovery';

// [TBO-29C C5 계정 청크] 아이디 찾기·비밀번호 재설정(비로그인 복구) — 재설정 토큰은 sha256 hash만
//  저장(평문·비밀번호 로그 금지), 1시간 만료, 사용/재설정 성공 시 명시 NULL(29B 토큰 규약 승계).
export const CREDENTIAL_RECOVERY_MIGRATION_SQL: readonly string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash varchar(64)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at timestamptz`,
];
