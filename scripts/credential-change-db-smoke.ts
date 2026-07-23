import 'reflect-metadata';
import { resolvePgSsl } from '../src/database/pg-ssl';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { config } from 'dotenv';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { directDatabaseUrl } from '../src/database/database-url';
import { createTestApp } from '../test/setup-app';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

const url = directDatabaseUrl();
if (!url) throw new Error('DATABASE_URL_UNPOOLED 또는 DATABASE_URL이 필요합니다.');

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function main(): Promise<void> {
  const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const beforeWebId = `tbo29_before_${stamp}`;
  const afterWebId = `tbo29_after_${stamp}`;
  const beforePassword = `Before-${randomBytes(12).toString('base64url')}`;
  const afterPassword = `After-${randomBytes(12).toString('base64url')}`;
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
  let userId = 0;
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;

  try {
    await dataSource.initialize();
    const inserted = await dataSource.query(
      `INSERT INTO users
        (web_id, name, role, status, password_hash, email_verified, auth_version, must_change_password)
       VALUES ($1, 'TBO-29 credential smoke', 'manager', 'active', $2, true, 1, true)
       RETURNING id`,
      [beforeWebId, await bcrypt.hash(beforePassword, 12)],
    );
    userId = Number(inserted[0].id);

    app = await createTestApp();
    let http = request(app.getHttpServer());
    const initial = await http.post('/api/auth/login').send({ webId: beforeWebId, password: beforePassword }).expect(201);
    if (initial.body.account?.mustChangePassword !== true) throw new Error('initial forced-change flag was not returned');
    const oldToken = String(initial.body.accessToken);
    await http.get('/api/students').set(auth(oldToken)).expect(403);
    await http.patch('/api/users/me/credentials').set(auth(oldToken)).send({
      currentPassword: beforePassword,
      newWebId: afterWebId,
      newPassword: afterPassword,
    }).expect(200);
    await http.get('/api/auth/me').set(auth(oldToken)).expect(401);
    await http.post('/api/auth/login').send({ webId: beforeWebId, password: beforePassword }).expect(401);
    const fresh = await http.post('/api/auth/login').send({ webId: afterWebId, password: afterPassword }).expect(201);
    if (fresh.body.account?.mustChangePassword !== false) throw new Error('forced-change flag was not cleared');
    await app.close();
    app = undefined;

    const [dbState] = await dataSource.query(
      `SELECT web_id, auth_version, must_change_password,
              (SELECT count(*)::int FROM audit_log
                WHERE entity='users' AND entity_id=$1 AND action='update'
                  AND changes::text NOT LIKE $2 AND changes::text NOT LIKE $3
                  AND changes::text NOT LIKE '%passwordHash%') AS redacted_audits
         FROM users WHERE id=$1`,
      [userId, `%${beforePassword}%`, `%${afterPassword}%`],
    );
    if (dbState?.web_id !== afterWebId || Number(dbState?.auth_version) !== 2 || dbState?.must_change_password !== false) {
      throw new Error('credential state did not persist atomically');
    }
    if (Number(dbState?.redacted_audits) !== 1) throw new Error('redacted credential audit was not persisted exactly once');

    app = await createTestApp();
    http = request(app.getHttpServer());
    await http.post('/api/auth/login').send({ webId: afterWebId, password: afterPassword }).expect(201);
    await app.close();
    app = undefined;

    console.log(JSON.stringify({
      ok: true,
      expected: { authVersion: 2, mustChangePassword: false, auditRows: 1, restartLogin: 201 },
      after: { authVersion: Number(dbState.auth_version), mustChangePassword: dbState.must_change_password, auditRows: Number(dbState.redacted_audits), restartLogin: 201 },
    }, null, 2));
  } finally {
    if (app) await app.close().catch(() => undefined);
    if (dataSource.isInitialized && userId) {
      await dataSource.transaction(async (manager) => {
        await manager.query(`DELETE FROM audit_log WHERE entity='users' AND entity_id=$1`, [userId]);
        await manager.query(
          `DELETE FROM auth_events WHERE user_id=$1 OR attempted_web_id_hash = ANY($2::varchar[])`,
          [userId, [sha256(beforeWebId.toLowerCase()), sha256(afterWebId.toLowerCase())]],
        );
        await manager.query(`DELETE FROM users WHERE id=$1`, [userId]);
      });
      const [residue] = await dataSource.query(
        `SELECT (SELECT count(*)::int FROM users WHERE id=$1) users,
                (SELECT count(*)::int FROM audit_log WHERE entity='users' AND entity_id=$1) audits,
                (SELECT count(*)::int FROM auth_events WHERE user_id=$1) auth_events`,
        [userId],
      );
      if (Number(residue.users) || Number(residue.audits) || Number(residue.auth_events)) {
        throw new Error(`credential smoke cleanup failed: ${JSON.stringify(residue)}`);
      }
    }
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
