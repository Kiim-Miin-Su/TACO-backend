import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { signupWithOtp } from './signup-helper'; // [TBO-31 C1] OTP 가입 헬퍼

type UserRow = {
  id: number;
  webId: string;
  authVersion?: number;
  mustChangePassword?: boolean;
  passwordHash: string;
  emailVerifyExpiresAt?: string | null;
};

// [TBO-66] full-run 부하에서 로그인(bcrypt)·연쇄 요청이 5s 기본을 넘겨 플레이크(2회 실측) — 스위트 한정 상향
jest.setTimeout(20000);

describe('Credential change and first-login gate (e2e, TBO-29B)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  const login = async (webId: string, password: string) =>
    (await http.post('/api/auth/login').send({ webId, password }).expect(201)).body;

  it('CEO first login: both fields required, business blocked, atomic change invalidates old JWT', async () => {
    // [E0.5 검증 보강] PG 모드는 로그인 경로가 refreshFromDb로 권위(DB)를 재수화 — 메모리만 갱신하면
    //  플래그가 지워진다. 권위 소스(PG)와 메모리 양쪽에 세팅(§13.83 이중 모드 학습 재적용).
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) await pg.query('UPDATE users SET must_change_password = true WHERE id = 3');
    db.update<UserRow>('users', 3, { mustChangePassword: true });
    const initial = await login('admin', 'demo1234');
    expect(initial.account.mustChangePassword).toBe(true);

    await http.get('/api/students').set('Authorization', `Bearer ${initial.accessToken}`).expect(403);
    await http.get('/api/auth/pending').set('Authorization', `Bearer ${initial.accessToken}`).expect(403);
    // [대표 추가요청 2026-07-16] 임시 비밀번호 상태에서도 통합 설정에 필요한 최소 경로는 허용 —
    //  이메일 인증 3종 + 국가/시간대 카탈로그(가드 allowlist). 업무 API는 위처럼 여전히 403.
    //  발송 자체는 SMTP 유무에 따라 201/503(이 스위트는 실 provider) — 403이 아니면 가드 통과가 증명된다.
    await http.get('/api/catalog/countries').set('Authorization', `Bearer ${initial.accessToken}`).expect(200);
    const allowedRes = await http.post('/api/profile-verifications').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'rotate@tnacademy.test', purpose: 'account_setup' });
    expect([201, 503]).toContain(allowedRes.status);
    if (allowedRes.status === 201) {
      // 활성 챌린지 (requester,channel) partial unique — 이후 테스트의 위조 헬퍼와 충돌하지 않게 만료.
      const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
      const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
      await app.get(PostgresCollectionStore).update(PROFILE_VERIFICATION_CHALLENGES_SPEC, allowedRes.body.id, { status: 'expired' });
    }
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'demo1234', newPassword: 'SecurePass123!' }).expect(400);
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'demo1234', newWebId: 'admin', newPassword: 'SecurePass123!' }).expect(400);
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'wrong-password', newWebId: 'ceo_owner', newPassword: 'SecurePass123!' }).expect(403);

    const changed = await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${initial.accessToken}`)
      .send({ currentPassword: 'demo1234', newWebId: 'ceo_owner', newPassword: 'SecurePass123!' }).expect(200);
    expect(changed.body).toMatchObject({ id: 3, webId: 'ceo_owner', mustChangePassword: false });
    expect(changed.body.passwordHash).toBeUndefined();

    await http.get('/api/auth/me').set('Authorization', `Bearer ${initial.accessToken}`).expect(401);
    await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(401);
    const fresh = await login('ceo_owner', 'SecurePass123!');
    expect(fresh.account.mustChangePassword).toBe(false);
    await http.get('/api/students').set('Authorization', `Bearer ${fresh.accessToken}`).expect(200);

    const audit = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((row) => row.entity === 'users' && row.entityId === 3 && row.action === 'update');
    expect(audit).toHaveLength(1);
    const serialized = JSON.stringify(audit[0]);
    expect(serialized).not.toContain('demo1234');
    expect(serialized).not.toContain('SecurePass123!');
    expect(serialized).not.toContain('passwordHash');
  });

  // [E0.5 ⑥ 대표 지시 2026-07-15] 첫 로그인 강제 변경에서 프로필(이름·이메일·휴대폰)까지 한 번에 —
  //  강제 흐름에서만 허용(평시엔 400 — 29B-4 인증/승인 경로 우회 금지), 이메일은 verified 유지·masked audit.
  it('forced rotation captures profile in one submit; non-forced profile via credentials is 400', async () => {
    // 평시(비강제) 프로필 동시 변경 시도 → 400
    const manager = await login('manager', 'demo1234');
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'demo1234', newPassword: 'ManagerPass456!', email: 'bypass@t.test' }).expect(400);

    // 강제 변경 재설정(앞 테스트에서 user 3은 ceo_owner/SecurePass123!로 회전됨)
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) await pg.query('UPDATE users SET must_change_password = true WHERE id = 3');
    db.update<UserRow>('users', 3, { mustChangePassword: true });
    const ceo = await login('ceo_owner', 'SecurePass123!');
    expect(ceo.account.mustChangePassword).toBe(true);

    // 전화 형식 위반 → 400 (가입 폼과 동일 규칙)
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${ceo.accessToken}`)
      .send({
        currentPassword: 'SecurePass123!', newWebId: 'ceo_minsun', newPassword: 'MinsunSecure1!',
        name: '김민선', email: 'ceo@tnacademy.test', phone: '0101234567',
      }).expect(400);

    // [대표 추가요청 2026-07-16] 이메일 포함 rotation인데 인증 챌린지 없음 → 400 (무인증 예외 폐지)
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${ceo.accessToken}`)
      .send({
        currentPassword: 'SecurePass123!', newWebId: 'ceo_minsun', newPassword: 'MinsunSecure1!',
        name: '김민선', email: 'CEO@tnacademy.test', phone: '010-5555-6666',
      }).expect(400);
    // 다른 이메일로 verified된 챌린지 → 400 (설정할 이메일과 대상 일치 필수) — 변경도 롤백
    const mismatch = await forgeVerifiedEmailChallenge(3, 'other@tnacademy.test', 'account_setup');
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${ceo.accessToken}`)
      .send({
        currentPassword: 'SecurePass123!', newWebId: 'ceo_minsun', newPassword: 'MinsunSecure1!',
        name: '김민선', email: 'CEO@tnacademy.test', phone: '010-5555-6666', verificationChallengeId: mismatch.id,
      }).expect(400);
    await login('ceo_owner', 'SecurePass123!'); // 롤백 확인 — 구 자격증명 그대로
    {
      const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
      const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
      await app.get(PostgresCollectionStore).update(PROFILE_VERIFICATION_CHALLENGES_SPEC, mismatch.id, { status: 'expired' });
    }

    // 설정할 새 이메일(canonical)로 verified 챌린지 → 200 + 같은 tx에서 consumed
    const rotation = await forgeVerifiedEmailChallenge(3, 'ceo@tnacademy.test', 'account_setup');
    const changed = await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${ceo.accessToken}`)
      .send({
        currentPassword: 'SecurePass123!', newWebId: 'ceo_minsun', newPassword: 'MinsunSecure1!',
        name: '김민선', email: 'CEO@tnacademy.test', phone: '010-5555-6666', verificationChallengeId: rotation.id,
        // [2026-07-16 확장] users 수정 가능 컬럼 전부 — 국가/시간대/출신교/전공/출생연도
        countryCode: 'KR', timeZone: 'Asia/Seoul', university: '한국대학교', major: '수학교육', birthYear: 1985,
      }).expect(200);
    expect(changed.body).toMatchObject({ id: 3, webId: 'ceo_minsun', name: '김민선', mustChangePassword: false });
    expect(db.findById<Record<string, unknown>>('profile_verification_challenges', rotation.id)).toMatchObject({ status: 'consumed' });

    // DB 반영: 이름/이메일(canonical lowercase)/전화/확장 컬럼 + emailVerified(이번엔 실제 인증 결과)
    const row = db.findById<UserRow & { name?: string; email?: string; phone?: string; emailVerified?: boolean;
      countryCode?: string; timeZone?: string; university?: string; major?: string; birthYear?: number }>('users', 3)!;
    expect(row).toMatchObject({
      name: '김민선', email: 'ceo@tnacademy.test', phone: '010-5555-6666', emailVerified: true,
      countryCode: 'KR', timeZone: 'Asia/Seoul', university: '한국대학교', major: '수학교육', birthYear: 1985,
    });

    // audit: 이메일/전화는 masked만 — 원문 미노출
    const audits = db.findAll<Record<string, unknown> & { id: number }>('audit_log')
      .filter((r) => r.entity === 'users' && r.entityId === 3 && r.action === 'update');
    const last = JSON.stringify(audits[audits.length - 1]);
    expect(last).not.toContain('ceo@tnacademy.test');
    expect(last).not.toContain('010-5555-6666');
    expect(last).not.toContain('MinsunSecure1!');

    // 새 자격증명으로 즉시 로그인 가능 + 강제 플래그 해제
    const fresh = await login('ceo_minsun', 'MinsunSecure1!');
    expect(fresh.account.mustChangePassword).toBe(false);
  });

  // [E0] 검증용 verified 이메일 challenge 위조 헬퍼 — store.insert(양 모드 권위 소스에 기록).
  //  실제 발송/코드 확인 흐름 회귀는 profile-verification.e2e-spec — 여기서는 소비 규약만 검증.
  const forgeVerifiedEmailChallenge = async (
    requesterId: number,
    target: string,
    purpose: 'profile_change' | 'password_change' | 'account_setup' = 'password_change',
  ) => {
    const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
    const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
    const store = app.get(PostgresCollectionStore);
    const now = Date.now();
    return store.insert<Record<string, unknown> & { id: number }>(PROFILE_VERIFICATION_CHALLENGES_SPEC, {
      requesterId, channel: 'email', purpose, targetNormalized: target,
      targetHash: 'test-forged', provider: 'fake_test', providerReference: null,
      codeHash: 'test-forged', status: 'verified', attemptCount: 0, resendCount: 0,
      resendAvailableAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
      verifiedAt: new Date(now).toISOString(), consumedAt: null, consumedByRequestId: null,
    });
  };

  // [E0] 평시 비밀번호 변경 = 본인 이메일 OTP 소비 필수(같은 tx) — 미제출 400·소진 후 재사용 불가.
  it('password change requires own-email OTP and consumes it exactly once', async () => {
    const manager = await login('manager', 'demo1234');
    // OTP 없이 → 400 (변경 없음)
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'demo1234', newPassword: 'ManagerPass123!' }).expect(400);
    await login('manager', 'demo1234');
    // 목적이 다른 본인 이메일 challenge도 교차 소비할 수 없다.
    const wrongPurpose = await forgeVerifiedEmailChallenge(4, 'manager@tnacademy.test', 'profile_change');
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'demo1234', newPassword: 'ManagerPass123!', verificationChallengeId: wrongPurpose.id }).expect(400);
    {
      const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
      const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
      await app.get(PostgresCollectionStore).update(PROFILE_VERIFICATION_CHALLENGES_SPEC, wrongPurpose.id, { status: 'expired' });
    }
    // 다른 이메일로 verified된 챌린지 → 400 (본인 현재 이메일만)
    const wrongTarget = await forgeVerifiedEmailChallenge(4, 'other@tnacademy.test');
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'demo1234', newPassword: 'ManagerPass123!', verificationChallengeId: wrongTarget.id }).expect(400);
    // [PG 불변식] 활성 챌린지는 (requester,channel)당 1건(partial unique) — 다음 위조 전 만료 처리.
    {
      const { PROFILE_VERIFICATION_CHALLENGES_SPEC } = await import('../src/database/calendar-asset-specs');
      const { PostgresCollectionStore } = await import('../src/database/postgres-collection.store');
      await app.get(PostgresCollectionStore).update(PROFILE_VERIFICATION_CHALLENGES_SPEC, wrongTarget.id, { status: 'expired' });
    }
    // 본인 이메일 verified 챌린지 → 200 + 챌린지 consumed + 기존 토큰 무효
    const challenge = await forgeVerifiedEmailChallenge(4, 'manager@tnacademy.test');
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'demo1234', newPassword: 'ManagerPass123!', verificationChallengeId: challenge.id }).expect(200);
    expect(db.findById<Record<string, unknown>>('profile_verification_challenges', challenge.id)).toMatchObject({ status: 'consumed' });
    await http.get('/api/auth/me').set('Authorization', `Bearer ${manager.accessToken}`).expect(401);
    const fresh = await login('manager', 'ManagerPass123!');
    // 소진된 챌린지 재사용 → 400 (비밀번호는 유지)
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${fresh.accessToken}`)
      .send({ currentPassword: 'ManagerPass123!', newPassword: 'ManagerPass456!', verificationChallengeId: challenge.id }).expect(400);
    await login('manager', 'ManagerPass123!');
  });

  it('audit failure rolls back password change and keeps the OTP unconsumed', async () => {
    const manager = await login('manager', 'ManagerPass123!');
    const before = { ...db.findById<UserRow>('users', 4)! };
    const challenge = await forgeVerifiedEmailChallenge(4, 'manager@tnacademy.test');
    const audit = app.get(AuditService);
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected audit failure'));
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'ManagerPass123!', newPassword: 'ManagerPass456!', verificationChallengeId: challenge.id }).expect(500);
    spy.mockRestore();
    const after = db.findById<UserRow>('users', 4)!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.mustChangePassword).toBe(before.mustChangePassword);
    expect(after.authVersion ?? 1).toBe(before.authVersion ?? 1);
    // [E0] 같은 tx 롤백 — 챌린지도 소비되지 않고 남는다(재시도 가능).
    expect(db.findById<Record<string, unknown>>('profile_verification_challenges', challenge.id)).toMatchObject({ status: 'verified' });
    await login('manager', 'ManagerPass123!');
  });

  // [E0] 아이디(webId) 즉시 변경 폐지 — 승인제 경유. [TBO-31 C1 D3] 요청 자체도 **대표만** 가능
  //  (매니저·강사·admin은 400) — 대표 요청은 즉시 적용 경로(같은 tx)에서 auth_version+1로 반영된다.
  it('webId change: instant change 400, non-super request 400, super applies with auth_version bump', async () => {
    const inst = await login('park_inst', 'demo1234');
    // 평시 즉시 변경 시도 → 400 (승인제 안내 — 첫 로그인 rotation만 예외)
    await http.patch('/api/users/me/credentials').set('Authorization', `Bearer ${inst.accessToken}`)
      .send({ currentPassword: 'demo1234', newWebId: 'park_renamed' }).expect(400);
    // [D3] 강사 webId 변경 요청 → 400 (역할 게이트 — 대표만)
    await http.post('/api/profile-change-requests').set('Authorization', `Bearer ${inst.accessToken}`)
      .send({ currentPassword: 'demo1234', webId: 'park_renamed', reason: '아이디 표기 정비를 요청합니다.' }).expect(400);
    expect(db.findById<UserRow>('users', 1)!.webId).toBe('park_inst'); // 변경 없음

    // 대표(user 3 — 앞 테스트 rotation으로 ceo_minsun) 요청은 허용: [D4] 본인 이메일 OTP 소비 필수.
    const superLogin = await login('ceo_minsun', 'MinsunSecure1!');
    const challenge = await forgeVerifiedEmailChallenge(3, 'ceo@tnacademy.test', 'profile_change');
    // 중복 webId(case-insensitive) → 409 (생성 선검사 — challenge는 소비되지 않고 남는다)
    await http.post('/api/profile-change-requests').set('Authorization', `Bearer ${superLogin.accessToken}`)
      .send({ currentPassword: 'MinsunSecure1!', webId: 'MANAGER', verificationChallengeId: challenge.id, reason: '다른 계정 아이디로 변경 시도.' }).expect(409);
    // 정상 요청 → 즉시 적용(같은 tx) → users 반영 + auth_version+1(기존 토큰 즉시 무효)
    const before = { ...db.findById<UserRow>('users', 3)! };
    const created = await http.post('/api/profile-change-requests').set('Authorization', `Bearer ${superLogin.accessToken}`)
      .send({ currentPassword: 'MinsunSecure1!', webId: 'ceo_rebrand', verificationChallengeId: challenge.id, reason: '대표 아이디 표기 정비를 요청합니다.' }).expect(201);
    expect(created.body).toMatchObject({ status: 'approved', requestedChanges: { webId: 'ceo_rebrand' } });
    const after = db.findById<UserRow>('users', 3)!;
    expect(after.webId).toBe('ceo_rebrand');
    expect(after.authVersion ?? 1).toBe((before.authVersion ?? 1) + 1);
    await http.get('/api/auth/me').set('Authorization', `Bearer ${superLogin.accessToken}`).expect(401); // 세션 무효
    await http.post('/api/auth/login').send({ webId: 'ceo_minsun', password: 'MinsunSecure1!' }).expect(401);
    await login('ceo_rebrand', 'MinsunSecure1!');
  });

  // [TBO-31 C1 D3] 매니저·admin의 webId 변경 요청 금지(서버 강제) — 종전의 "동시 승인 경쟁" 시나리오는
  //  요청 주체가 대표(즉시 적용) 하나뿐이라 더 이상 구성 불가. case-insensitive 선점 검사는 위
  //  테스트(대표 409)와 changeCredentials rotation 경로가 계속 검증한다.
  it('non-super webId change requests are rejected by the role gate', async () => {
    const manager = await login('manager', 'ManagerPass123!');
    const profAdmin = await login('prof_admin', 'demo1234');
    await http.post('/api/profile-change-requests').set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ currentPassword: 'ManagerPass123!', webId: 'SharedOps', reason: '운영 계정 아이디로 변경 요청.' }).expect(400);
    await http.post('/api/profile-change-requests').set('Authorization', `Bearer ${profAdmin.accessToken}`)
      .send({ currentPassword: 'demo1234', webId: 'sharedops', reason: '운영 계정 아이디로 변경 요청.' }).expect(400);
    // 어떤 계정도 해당 아이디를 얻지 못했고 요청 행도 남지 않는다.
    const owners = db.findAll<UserRow>('users').filter((user) => user.webId.toLowerCase() === 'sharedops');
    expect(owners).toHaveLength(0);
  });

  // [TBO-31 C1] 신규 가입은 OTP로 emailVerified=true 생성 — 링크 인증은 잔존(구 흐름) 계정 호환.
  //  잔존 상태를 DB 강제 세팅으로 재현해 단일 사용·만료 거부 규약을 계속 검증한다(약화 없음).
  it('legacy verification token is single-use and expired tokens are rejected', async () => {
    const stamp = Date.now();
    const { createHash } = await import('crypto');
    const forgeLegacy = async (suffix: string) => {
      const webId = `verify_${suffix}_${stamp}`;
      const body = await signupWithOtp(http, {
        webId, name: `인증 ${suffix}`, email: `${webId}@example.test`, password: 'VerifyPass123!', role: 'instructor',
      });
      const token = `legacy-token-${suffix}-${stamp}`;
      const hash = createHash('sha256').update(token).digest('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const pg = app.get(PostgresConnectionService);
      if (pg.ready) {
        await pg.query(
          'UPDATE users SET email_verified = false, email_verify_token_hash = $1, email_verify_expires_at = $2 WHERE id = $3',
          [hash, expires, body.account.id],
        );
      }
      db.update('users', body.account.id, {
        emailVerified: false, emailVerifyTokenHash: hash, emailVerifyExpiresAt: expires,
      } as never);
      return { id: body.account.id, token };
    };

    const reusable = await forgeLegacy('once');
    await http.get(`/api/auth/verify-email?token=${reusable.token}`).expect(200);
    await http.get(`/api/auth/verify-email?token=${reusable.token}`).expect(400);

    const expired = await forgeLegacy('expired');
    // [E0.5 검증 보강] PG 모드 권위 소스에도 만료 기록(메모리만 갱신 시 refreshFromDb가 되돌림).
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) await pg.query(`UPDATE users SET email_verify_expires_at = '2000-01-01T00:00:00Z' WHERE id = ${expired.id}`);
    db.update<UserRow>('users', expired.id, { emailVerifyExpiresAt: '2000-01-01T00:00:00.000Z' });
    await http.get(`/api/auth/verify-email?token=${expired.token}`).expect(400);
  });
});
