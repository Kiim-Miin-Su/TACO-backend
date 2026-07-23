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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

async function main(): Promise<void> {
  const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const requesterWebId = `profile_req_${stamp}`;
  const reviewerWebId = `profile_admin_${stamp}`;
  const password = `Profile-${randomBytes(12).toString('base64url')}`;
  const dataSource = new DataSource({
    type: 'postgres', url, synchronize: false, migrationsRun: false, logging: false, entities: [], migrations: [],
    ssl: resolvePgSsl() /* [TBO-34 C2-C] TLS 단일 진실원 — production 검증 강제 */,
    extra: { max: 1, connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000) },
  });
  let requesterId = 0;
  let reviewerId = 0;
  let requestId = 0;
  let app: Awaited<ReturnType<typeof createTestApp>> | undefined;

  try {
    await dataSource.initialize();
    const passwordHash = await bcrypt.hash(password, 12);
    const inserted = await dataSource.query(
      `INSERT INTO users
        (web_id, name, role, status, password_hash, email_verified, auth_version, profile_version, must_change_password)
       VALUES ($1, 'Profile smoke requester', 'manager', 'active', $3, true, 1, 1, false),
              ($2, 'Profile smoke reviewer', 'admin', 'active', $3, true, 1, 1, false)
       RETURNING id, web_id`,
      [requesterWebId, reviewerWebId, passwordHash],
    );
    requesterId = Number(inserted.find((row: { web_id: string }) => row.web_id === requesterWebId)?.id);
    reviewerId = Number(inserted.find((row: { web_id: string }) => row.web_id === reviewerWebId)?.id);

    app = await createTestApp();
    let http = request(app.getHttpServer());
    const requesterLogin = await http.post('/api/auth/login').send({ webId: requesterWebId, password }).expect(201);
    const requesterToken = String(requesterLogin.body.accessToken);
    const created = await http.post('/api/profile-change-requests').set(auth(requesterToken)).send({
      currentPassword: password, // [TBO-29B-4] 모든 변경은 현재 비밀번호 재확인
      name: 'Profile smoke applied',
      countryCode: 'US-W',
      timeZone: 'America/Los_Angeles',
      reason: '실 DB 승인 트랜잭션 검증 요청입니다.',
    }).expect(201);
    // 연락처(phone/email) 변경은 인증 challenge 필수 — 해당 흐름은 profile-verification-db-smoke가 검증
    requestId = Number(created.body.id);
    await app.close();
    app = undefined;

    app = await createTestApp();
    http = request(app.getHttpServer());
    const reviewerLogin = await http.post('/api/auth/login').send({ webId: reviewerWebId, password }).expect(201);
    const reviewerToken = String(reviewerLogin.body.accessToken);
    const queue = await http.get('/api/profile-change-requests').set(auth(reviewerToken)).expect(200);
    if (!queue.body.some((row: { id: number; status: string }) => row.id === requestId && row.status === 'pending')) {
      throw new Error('restart 이후 승인 대기 요청이 조회되지 않았습니다.');
    }
    await http.post(`/api/profile-change-requests/${requestId}/approve`).set(auth(reviewerToken)).send({}).expect(201);
    await app.close();
    app = undefined;

    const [after] = await dataSource.query(
      `SELECT u.name, u.phone, u.country_code, u.time_zone, u.profile_version,
              r.status, r.base_profile_version, r.applied_profile_version,
              r.before_values, r.requested_changes,
              (SELECT count(*)::int FROM audit_log WHERE entity='profile_change_requests' AND entity_id=$2 AND action='create') AS request_create_audits,
              (SELECT count(*)::int FROM audit_log WHERE entity='profile_change_requests' AND entity_id=$2 AND action='approve') AS request_approve_audits,
              (SELECT count(*)::int FROM audit_log WHERE entity='users' AND entity_id=$1 AND action='update') AS user_update_audits
         FROM users u JOIN profile_change_requests r ON r.requester_id=u.id
        WHERE u.id=$1 AND r.id=$2`,
      [requesterId, requestId],
    );
    const expected = {
      name: 'Profile smoke applied', phone: null, countryCode: 'US-W',
      timeZone: 'America/Los_Angeles', profileVersion: 2, status: 'approved',
      baseProfileVersion: 1, appliedProfileVersion: 2,
      requestCreateAudits: 1, requestApproveAudits: 1, userUpdateAudits: 1, restartReadback: 200,
    };
    const actual = {
      name: after?.name, phone: after?.phone, countryCode: after?.country_code,
      timeZone: after?.time_zone, profileVersion: Number(after?.profile_version), status: after?.status,
      baseProfileVersion: Number(after?.base_profile_version), appliedProfileVersion: Number(after?.applied_profile_version),
      requestCreateAudits: Number(after?.request_create_audits), requestApproveAudits: Number(after?.request_approve_audits),
      userUpdateAudits: Number(after?.user_update_audits), restartReadback: 200,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`profile transaction expected/after mismatch: ${JSON.stringify({ expected, actual })}`);
    }

    app = await createTestApp();
    http = request(app.getHttpServer());
    const relogin = await http.post('/api/auth/login').send({ webId: requesterWebId, password }).expect(201);
    const readback = await http.get('/api/users/me/profile').set(auth(String(relogin.body.accessToken))).expect(200);
    if (readback.body.profileVersion !== 2 || readback.body.name !== expected.name) throw new Error('restart profile readback mismatch');
    await app.close();
    app = undefined;

    console.log(JSON.stringify({ ok: true, expected, after: actual }, null, 2));
  } finally {
    if (app) await app.close().catch(() => undefined);
    if (dataSource.isInitialized && requesterId && reviewerId) {
      await dataSource.transaction(async (manager) => {
        if (requestId) {
          await manager.query(`DELETE FROM audit_log WHERE entity='profile_change_requests' AND entity_id=$1`, [requestId]);
          await manager.query(`DELETE FROM profile_change_requests WHERE id=$1`, [requestId]);
        }
        await manager.query(`DELETE FROM audit_log WHERE entity='users' AND entity_id = ANY($1::int[])`, [[requesterId, reviewerId]]);
        await manager.query(
          `DELETE FROM auth_events WHERE user_id = ANY($1::int[]) OR attempted_web_id_hash = ANY($2::varchar[])`,
          [[requesterId, reviewerId], [sha256(requesterWebId.toLowerCase()), sha256(reviewerWebId.toLowerCase())]],
        );
        await manager.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[requesterId, reviewerId]]);
      });
      const [residue] = await dataSource.query(
        `SELECT (SELECT count(*)::int FROM users WHERE id = ANY($1::int[])) AS users,
                (SELECT count(*)::int FROM profile_change_requests WHERE id=$2) AS requests,
                (SELECT count(*)::int FROM audit_log WHERE (entity='users' AND entity_id = ANY($1::int[])) OR (entity='profile_change_requests' AND entity_id=$2)) AS audits,
                (SELECT count(*)::int FROM auth_events WHERE user_id = ANY($1::int[])) AS auth_events`,
        [[requesterId, reviewerId], requestId || 0],
      );
      if (Object.values(residue).some((value) => Number(value) !== 0)) {
        throw new Error(`profile smoke cleanup failed: ${JSON.stringify(residue)}`);
      }
    }
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
