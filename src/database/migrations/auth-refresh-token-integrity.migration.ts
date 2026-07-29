export const AUTH_REFRESH_TOKEN_INTEGRITY_MIGRATION_ID =
  '20260729_02_76h_auth_refresh_token_integrity';

export const AUTH_REFRESH_TOKEN_CONSTRAINTS = [
  'fk_auth_refresh_user',
  'fk_auth_refresh_replaced_by',
  'c_auth_refresh_not_self_replaced',
  'c_auth_refresh_expiry_after_create',
] as const;

/**
 * Refresh-token 회전 체인의 물리 무결성.
 *
 * 운영 순서:
 * 1. 별도 inventory에서 orphan/self-link/cycle/invalid expiry가 0인지 확인한다.
 * 2. NOT VALID로 제약을 추가한 뒤 VALIDATE하여 기존 행과 신규 행을 모두 보호한다.
 * 3. migration ledger와 pg_constraint readback이 모두 일치해야 완료로 판정한다.
 *
 * 다중 행 cycle은 PostgreSQL CHECK로 표현할 수 없다. 기존 cycle은 inventory가 차단하고,
 * 이후 successor는 RefreshTokensService의 row-lock transaction 안에서 새 행으로만 생성한다.
 */
export const AUTH_REFRESH_TOKEN_INTEGRITY_SQL: readonly string[] = [
  `DO $$
   DECLARE bad integer;
   BEGIN
     IF to_regclass('public.auth_refresh_tokens') IS NULL THEN
       RAISE EXCEPTION 'auth_refresh_tokens table is missing';
     END IF;
     IF to_regclass('public.users') IS NULL THEN
       RAISE EXCEPTION 'users table is missing';
     END IF;

     SELECT COUNT(*) INTO bad
       FROM auth_refresh_tokens t
       LEFT JOIN users u ON u.id = t.user_id
       WHERE u.id IS NULL;
     IF bad > 0 THEN
       RAISE EXCEPTION 'auth_refresh_tokens.user_id orphan % rows', bad;
     END IF;

     SELECT COUNT(*) INTO bad
       FROM auth_refresh_tokens t
       LEFT JOIN auth_refresh_tokens successor ON successor.id = t.replaced_by_id
       WHERE t.replaced_by_id IS NOT NULL AND successor.id IS NULL;
     IF bad > 0 THEN
       RAISE EXCEPTION 'auth_refresh_tokens.replaced_by_id orphan % rows', bad;
     END IF;

     SELECT COUNT(*) INTO bad
       FROM auth_refresh_tokens
       WHERE replaced_by_id = id;
     IF bad > 0 THEN
       RAISE EXCEPTION 'auth_refresh_tokens self-link % rows', bad;
     END IF;

     SELECT COUNT(*) INTO bad
       FROM auth_refresh_tokens
       WHERE expires_at <= created_at;
     IF bad > 0 THEN
       RAISE EXCEPTION 'auth_refresh_tokens invalid expiry % rows', bad;
     END IF;

     WITH RECURSIVE chain AS (
       SELECT id AS root_id, id, replaced_by_id, ARRAY[id] AS path, false AS cycle
         FROM auth_refresh_tokens
       UNION ALL
       SELECT chain.root_id, successor.id, successor.replaced_by_id,
              chain.path || successor.id, successor.id = ANY(chain.path)
         FROM chain
         JOIN auth_refresh_tokens successor ON successor.id = chain.replaced_by_id
        WHERE chain.replaced_by_id IS NOT NULL AND NOT chain.cycle
     )
     SELECT COUNT(DISTINCT root_id) INTO bad FROM chain WHERE cycle;
     IF bad > 0 THEN
       RAISE EXCEPTION 'auth_refresh_tokens cycle % roots', bad;
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname='fk_auth_refresh_user'
          AND conrelid='public.auth_refresh_tokens'::regclass
     ) THEN
       ALTER TABLE auth_refresh_tokens
         ADD CONSTRAINT fk_auth_refresh_user
         FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname='fk_auth_refresh_replaced_by'
          AND conrelid='public.auth_refresh_tokens'::regclass
     ) THEN
       ALTER TABLE auth_refresh_tokens
         ADD CONSTRAINT fk_auth_refresh_replaced_by
         FOREIGN KEY (replaced_by_id) REFERENCES auth_refresh_tokens(id) NOT VALID;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname='c_auth_refresh_not_self_replaced'
          AND conrelid='public.auth_refresh_tokens'::regclass
     ) THEN
       ALTER TABLE auth_refresh_tokens
         ADD CONSTRAINT c_auth_refresh_not_self_replaced
         CHECK (replaced_by_id IS NULL OR replaced_by_id <> id) NOT VALID;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname='c_auth_refresh_expiry_after_create'
          AND conrelid='public.auth_refresh_tokens'::regclass
     ) THEN
       ALTER TABLE auth_refresh_tokens
         ADD CONSTRAINT c_auth_refresh_expiry_after_create
         CHECK (expires_at > created_at) NOT VALID;
     END IF;
   END $$`,
  `DO $$
   DECLARE constraint_row record;
   BEGIN
     FOR constraint_row IN
       SELECT conname, conrelid::regclass::text AS table_name
         FROM pg_constraint
        WHERE conrelid='public.auth_refresh_tokens'::regclass
          AND conname IN (
          'fk_auth_refresh_user',
          'fk_auth_refresh_replaced_by',
          'c_auth_refresh_not_self_replaced',
          'c_auth_refresh_expiry_after_create'
        )
          AND NOT convalidated
     LOOP
       EXECUTE format(
         'ALTER TABLE %s VALIDATE CONSTRAINT %I',
         constraint_row.table_name,
         constraint_row.conname
       );
     END LOOP;
   END $$`,
  `CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_replaced_by
     ON auth_refresh_tokens (replaced_by_id)
     WHERE replaced_by_id IS NOT NULL`,
];
