import {
  AUTH_REFRESH_TOKEN_CONSTRAINTS,
  AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID,
  AUTH_REFRESH_TOKEN_INTEGRITY_SQL,
} from '../src/database/migrations/auth-refresh-token-integrity.migration';

describe('TBO-76H auth refresh token integrity migration contract', () => {
  it('uses a versioned ledger id and the complete FK/CHECK surface', () => {
    expect(AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID).toBe(
      '20260729_02_76h_auth_refresh_token_integrity',
    );
    expect(AUTH_REFRESH_TOKEN_CONSTRAINTS).toEqual([
      'fk_auth_refresh_user',
      'fk_auth_refresh_replaced_by',
      'c_auth_refresh_not_self_replaced',
      'c_auth_refresh_expiry_after_create',
    ]);
  });

  it('gates dirty data before adding and validating constraints', () => {
    const sql = AUTH_REFRESH_TOKEN_INTEGRITY_SQL.join('\n');
    expect(sql).toContain('auth_refresh_tokens.user_id orphan');
    expect(sql).toContain('auth_refresh_tokens.replaced_by_id orphan');
    expect(sql).toContain('auth_refresh_tokens self-link');
    expect(sql).toContain('auth_refresh_tokens invalid expiry');
    expect(sql).toContain('auth_refresh_tokens cycle');
    expect(sql).toContain('NOT VALID');
    expect(sql).toContain('VALIDATE CONSTRAINT');
    expect(sql).toContain('idx_auth_refresh_tokens_replaced_by');
    expect(sql).toContain("conrelid='public.auth_refresh_tokens'::regclass");
  });
});
