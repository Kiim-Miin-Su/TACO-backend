import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { loadLocalEnv } from '../src/config/load-env';
import { directDatabaseUrl } from '../src/database/database-url';
import { TBO29_AUTH_MIGRATION_ID } from '../src/database/migrations/tbo29-auth.migration';

loadLocalEnv();

const apply = process.env.APPLY === '1';
const password = process.env.CEO_TEMP_PASSWORD;
const url = directDatabaseUrl();
const adminIdentityLockId = Number.parseInt(createHash('sha256').update('admin').digest('hex').slice(0, 7), 16);

if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');
if (!password) throw new Error('CEO_TEMP_PASSWORD가 필요합니다.');
if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('CEO_TEMP_PASSWORD는 72바이트 이하여야 합니다.');
if (!apply) {
  console.log(JSON.stringify({
    ok: false, dryRun: true, targetWebId: 'admin',
    action: 'set temporary CEO credential and require change',
    // [대표 지시 2026-07-16] super_admin 단일 계정 불변식 — 대상 외 super_admin은 soft delete+세션 revoke.
    alsoEnforces: 'singleton super_admin (other super_admins are soft-deleted and revoked)',
  }, null, 2));
  process.exit(0);
}

const dataSource = new DataSource({
  type: 'postgres',
  url,
  synchronize: false,
  migrationsRun: false,
  logging: false,
  entities: [],
  ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
  extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
});

async function main(): Promise<void> {
  await dataSource.initialize();
  const passwordHash = await bcrypt.hash(password as string, 12);
  const result = await dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [6, adminIdentityLockId]);
    const migration = await manager.query(`SELECT to_regclass('public.schema_migrations') AS table_name`);
    if (!migration[0]?.table_name) throw new Error('TBO-29 auth migration을 먼저 적용하세요.');
    const applied = await manager.query('SELECT id FROM schema_migrations WHERE id=$1', [TBO29_AUTH_MIGRATION_ID]);
    if (!applied.length) throw new Error('TBO-29 auth migration을 먼저 적용하세요.');
    const rows = await manager.query(
      `SELECT id, auth_version FROM users
        WHERE deleted_at IS NULL AND (lower(web_id) = 'admin' OR role = 'super_admin')
        ORDER BY CASE WHEN lower(web_id) = 'admin' THEN 0 ELSE 1 END, id
        LIMIT 1 FOR UPDATE`,
    );
    let id: number;
    if (rows[0]) {
      id = Number(rows[0].id);
      await manager.query(
        `UPDATE users
           SET web_id = 'admin', role = 'super_admin', status = 'active', email_verified = true,
               password_hash = $1, must_change_password = true,
               auth_version = COALESCE(auth_version, 1) + 1, updated_at = now()
         WHERE id = $2`,
        [passwordHash, id],
      );
    } else {
      const inserted = await manager.query(
        `INSERT INTO users
          (web_id, name, role, status, password_hash, email_verified, auth_version, must_change_password)
         VALUES ('admin', '대표', 'super_admin', 'active', $1, true, 1, true)
         RETURNING id`,
        [passwordHash],
      );
      id = Number(inserted[0].id);
    }
    // [대표 지시 2026-07-16] **super_admin 단일 계정 불변식** — 리셋 대상 외의 super_admin은
    //  같은 tx에서 soft delete(deleted_at/by) + auth_version+1(발급된 토큰 즉시 무효 = revoke).
    //  role 강등이 아니라 삭제인 이유: 대표 지시 원문("삭제 및 revoke"). 복구는 대표가 DB에서만.
    // [함정] TypeORM manager.query의 UPDATE…RETURNING은 [rows, affectedCount] 튜플 — rows만 취한다.
    const [demoted] = (await manager.query(
      `UPDATE users
          SET deleted_at = now(), deleted_by = $1,
              auth_version = COALESCE(auth_version, 1) + 1, updated_at = now()
        WHERE deleted_at IS NULL AND role = 'super_admin' AND id <> $1
        RETURNING id, web_id`,
      [id],
    )) as [Array<{ id: number; web_id: string }>, number];
    const auditTable = await manager.query(`SELECT to_regclass('public.audit_log') AS table_name`);
    if (auditTable[0]?.table_name) {
      await manager.query(
        `INSERT INTO audit_log (entity, entity_id, action, actor_id, at, changes, reason)
         VALUES ('users', $1, 'update', $1, now(), $2, 'CEO temporary credential bootstrap')`,
        [id, JSON.stringify({ password: { after: '[temporary]' }, mustChangePassword: { after: true } })],
      );
      for (const gone of demoted) {
        await manager.query(
          `INSERT INTO audit_log (entity, entity_id, action, actor_id, at, changes, reason)
           VALUES ('users', $1, 'remove', $2, now(), $3, 'super_admin 단일 계정 불변식 — CEO 리셋이 잉여 super_admin 삭제·revoke')`,
          [gone.id, id, JSON.stringify({ deletedAt: { after: '[now]' }, authVersion: { after: '[+1 revoke]' } })],
        );
      }
    }
    return { id, removedSuperAdmins: demoted.map((row) => `${row.web_id}(#${row.id})`) };
  });
  const [verified] = await dataSource.query(
    `SELECT id, web_id, role, status, email_verified, must_change_password, auth_version
       FROM users WHERE id = $1`,
    [result.id],
  );
  const [remaining] = await dataSource.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE deleted_at IS NULL AND role = 'super_admin'`,
  );
  console.log(JSON.stringify({
    ok: true, account: verified,
    removedSuperAdmins: result.removedSuperAdmins, // 삭제·revoke된 잉여 super_admin(단일 불변식)
    activeSuperAdmins: remaining.n, // 항상 1이어야 정상
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
