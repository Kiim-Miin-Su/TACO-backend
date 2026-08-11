// [TBO-31 C1] 가입 전 이메일 OTP(D1) · 주민등록번호(D2) · 아이디 정책(D3) · 프로필 변경 상시 OTP(D4)
//  신규 규약 전수 e2e. PG 모드에서는 스위트별 fresh DB로도 재실행된다(§18-5 규약).
//  ⚠ 테스트 순서 의존: ⑥(대표 webId 즉시 적용)은 admin 로그인 아이디를 바꾸므로 마지막에서 두 번째,
//    ⑦(manager 상시 OTP — pending 생성)은 그 뒤에 둔다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { decryptRrn } from '../src/common/rrn-crypto.util';
import { forgeVerifiedEmailChallenge } from './profile-challenge-helper';
import { verifiedSignupChallenge } from './signup-helper';

type UserRow = {
  id: number; webId: string; emailVerified?: boolean; birthYear?: number | null; rrnEncrypted?: string | null;
};
type ChallengeRow = {
  id: number; status: string; attemptCount: number; consumedByUserId?: number | null; emailNormalized: string;
};

describe('Signup email OTP + RRN + webId policy (e2e, TBO-31 C1)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (webId: string, password = 'demo1234') =>
    (await http.post('/api/auth/login').send({ webId, password }).expect(201)).body.accessToken as string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  const challengeOf = (id: number) => db.findById<ChallengeRow>('signup_email_challenges', id)!;

  it('① OTP 발송(devOtpCode)→오답 5회 잠금→새 챌린지→confirm→signup 201(파생·암호화·마스킹)', async () => {
    const email = 'otp1@t31.test';
    const created = (await http.post('/api/auth/signup-email-challenge').send({ email }).expect(201)).body;
    expect(created.id).toBeGreaterThan(0);
    expect(String(created.devOtpCode)).toMatch(/^\d{6}$/); // SMTP 미설정 비prod — devOtpCode 관례
    expect(created.maskedTarget).not.toContain('otp1@t31.test'); // canonical 미노출(마스킹만)
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(created.resendAvailableAt)).toBeGreaterThan(Date.now());
    // 평문 코드는 저장되지 않는다(hash만)
    expect(JSON.stringify(challengeOf(created.id))).not.toContain(String(created.devOtpCode));

    // 오답 5회 → locked(카운터는 DB 영속 — 예외보다 먼저 커밋)
    for (let i = 0; i < 5; i += 1) {
      await http.post(`/api/auth/signup-email-challenge/${created.id}/confirm`)
        .send({ email, code: '000000' }).expect(400);
    }
    expect(challengeOf(created.id).status).toBe('locked');
    // 잠긴 뒤엔 정답도 거부
    await http.post(`/api/auth/signup-email-challenge/${created.id}/confirm`)
      .send({ email, code: created.devOtpCode }).expect(400);

    // 새 챌린지(locked는 비활성 — 쿨다운 대상 아님) → confirm → verified
    const fresh = (await http.post('/api/auth/signup-email-challenge').send({ email }).expect(201)).body;
    const confirmed = (await http.post(`/api/auth/signup-email-challenge/${fresh.id}/confirm`)
      .send({ email, code: fresh.devOtpCode }).expect(201)).body;
    expect(confirmed).toEqual({ id: fresh.id, status: 'verified' });

    // 가입 — emailVerified=true 생성 · birthYear 파생(950101-1 → 1995) · 암호문만 저장
    const res = await http.post('/api/auth/signup').send({
      webId: 't31_otp1', name: '가입자일', email, password: 'password123',
      rrn: '950101-1234567', emailChallengeId: fresh.id, role: 'instructor',
    }).expect(201);
    expect(res.body.account.status).toBe('pending');
    expect(res.body.devVerifyLink).toBeUndefined(); // 48h 링크 단계 소멸
    expect(JSON.stringify(res.body)).not.toContain('950101'); // 응답에 RRN 평문·부분 노출 0
    const id = res.body.account.id as number;

    const row = db.findById<UserRow>('users', id)!;
    expect(row.emailVerified).toBe(true);
    expect(row.birthYear).toBe(1995);
    expect(row.rrnEncrypted).toBeTruthy();
    expect(String(row.rrnEncrypted)).not.toContain('950101'); // 암호문 ≠ 평문
    expect(decryptRrn(String(row.rrnEncrypted))).toBe('950101-1234567'); // 복호화 일치(canonical)
    // PG 모드면 권위 소스의 암호문도 동일(평문 아님)
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) {
      const rows = await pg.query<{ rrn_encrypted: string }>('SELECT rrn_encrypted FROM users WHERE id = $1', [id]);
      expect(rows[0].rrn_encrypted).toBe(row.rrnEncrypted);
      expect(rows[0].rrn_encrypted).not.toContain('950101');
    }
    // challenge는 같은 tx에서 일회 소비 — consumed + consumed_by_user_id
    expect(challengeOf(fresh.id)).toMatchObject({ status: 'consumed', consumedByUserId: id });
    // 같은 이메일 재가입은 OTP 재사용 판정보다 앞선 연락처 중복 게이트에서 409.
    const replay = await http.post('/api/auth/signup').send({
      webId: 't31_otp1_re', name: '재사용', email, password: 'password123',
      rrn: '950101-1234567', emailChallengeId: fresh.id,
    }).expect(409);
    expect(replay.body.code).toBe('SIGNUP_EMAIL_ALREADY_REGISTERED');

    // 승인센터 pending 목록 — rrnMasked 형식('950101-1******')·평문/암호문 미노출·birthYear 유지
    const admin = await login('admin');
    const pending = (await http.get('/api/auth/pending').set(bearer(admin)).expect(200)).body;
    const mine = pending.find((p: { webId: string }) => p.webId === 't31_otp1');
    expect(mine).toMatchObject({ rrnMasked: '950101-1******', birthYear: 1995 });
    expect(mine.rrnEncrypted).toBeUndefined();
    expect(JSON.stringify(pending)).not.toContain('950101-1234567');
  });

  it('①b 쿨다운 400 + 이미 가입된 이메일은 409이고 challenge를 만들지 않는다', async () => {
    const email = 'cooldown@t31.test';
    const first = (await http.post('/api/auth/signup-email-challenge').send({ email }).expect(201)).body;
    // 쿨다운(60초) 내 재요청 → 400 (pending 활성 기준)
    await http.post('/api/auth/signup-email-challenge').send({ email }).expect(400);
    expect(challengeOf(first.id).status).toBe('pending');

    const before = db.findAll<ChallengeRow>('signup_email_challenges').length;
    const taken = await http.post('/api/auth/signup-email-challenge')
      .send({ email: 'ADMIN@tnacademy.test' }).expect(409);
    expect(taken.body).toMatchObject({
      code: 'SIGNUP_EMAIL_ALREADY_REGISTERED',
      message: '이미 가입된 이메일입니다.',
    });
    expect(db.findAll<ChallengeRow>('signup_email_challenges')).toHaveLength(before);
  });

  it('② 미인증(pending) 챌린지로 signup → 400, 계정 미생성(같은 tx 롤백)', async () => {
    const email = 'unverified@t31.test';
    const created = (await http.post('/api/auth/signup-email-challenge').send({ email }).expect(201)).body;
    const before = db.findAll<UserRow>('users').length;
    await http.post('/api/auth/signup').send({
      webId: 't31_unverified', name: '미인증', email, password: 'password123',
      rrn: '950101-1234567', emailChallengeId: created.id,
    }).expect(400);
    expect(db.findAll<UserRow>('users').length).toBe(before);
    expect(db.findAll<UserRow>('users').some((u) => u.webId === 't31_unverified')).toBe(false);
    expect(challengeOf(created.id).status).toBe('pending'); // 소비되지 않음
  });

  it('③ 이메일 불일치: 다른 이메일로 verified된 챌린지 → signup 400', async () => {
    const challengeId = await verifiedSignupChallenge(http, 'match-a@t31.test');
    await http.post('/api/auth/signup').send({
      webId: 't31_mismatch', name: '불일치', email: 'match-b@t31.test', password: 'password123',
      rrn: '950101-1234567', emailChallengeId: challengeId,
    }).expect(400);
    expect(db.findAll<UserRow>('users').some((u) => u.webId === 't31_mismatch')).toBe(false);
  });

  it('④ RRN 형식 위반 400 · 체크섬은 검증하지 않는다(형식만 유효하면 201)', async () => {
    const email = 'rrn@t31.test';
    const challengeId = await verifiedSignupChallenge(http, email);
    const base = { webId: 't31_rrn', name: '알알엔', email, password: 'password123', emailChallengeId: challengeId };
    await http.post('/api/auth/signup').send({ ...base, rrn: '95010112345678' }).expect(400); // 자릿수 초과
    await http.post('/api/auth/signup').send({ ...base, rrn: '950101-923456' }).expect(400); // 자릿수 부족
    await http.post('/api/auth/signup').send({ ...base, rrn: '950101-9234567' }).expect(400); // 성별자리 9
    await http.post('/api/auth/signup').send({ ...base, rrn: '951301-1234567' }).expect(400); // 13월
    await http.post('/api/auth/signup').send({ ...base, rrn: '950132-1234567' }).expect(400); // 32일
    // 구 검증식(체크섬)으로는 무효인 번호 — 형식이 유효하므로 통과(2020-10 이후 임의번호 수용).
    //  하이픈 없이 제출해도 canonical(하이픈 포함)으로 통일 저장, 성별 4 → 2004년 파생.
    const ok = await http.post('/api/auth/signup').send({ ...base, rrn: '0402294000000' }).expect(201);
    const row = db.findById<UserRow>('users', ok.body.account.id)!;
    expect(row.birthYear).toBe(2004);
    expect(decryptRrn(String(row.rrnEncrypted))).toBe('040229-4000000');
  });

  it('⑤ web-id-available: 사용 중 false(case-insensitive) · 미사용 true · 3자 미만 400', async () => {
    // 응답은 {available}만 — 이름·역할 미노출(H2 열거 취약 재발 방지)
    expect((await http.get('/api/auth/web-id-available?webId=admin').expect(200)).body).toEqual({ available: false });
    expect((await http.get('/api/auth/web-id-available?webId=ADMIN').expect(200)).body).toEqual({ available: false });
    expect((await http.get('/api/auth/web-id-available?webId=t31_totally_new').expect(200)).body).toEqual({ available: true });
    await http.get('/api/auth/web-id-available?webId=ab').expect(400);
    await http.get('/api/auth/web-id-available').expect(400);
  });

  it('⑥ webId 정책: 매니저 요청 400(역할 게이트) · super_admin은 즉시 적용(+상시 OTP·세션 무효)', async () => {
    const manager = await login('manager');
    await http.post('/api/profile-change-requests').set(bearer(manager))
      .send({ currentPassword: 'demo1234', webId: 'mgr_new_id', reason: '매니저 아이디 변경 요청입니다.' })
      .expect(400);
    expect(db.findAll<UserRow>('users').some((u) => u.webId === 'mgr_new_id')).toBe(false);

    // 대표는 허용 — [D4] 본인 이메일 OTP 소비 필수 + 즉시 적용(같은 tx) + auth_version+1
    const superToken = await login('admin');
    const challengeId = await forgeVerifiedEmailChallenge(app, 3, 'admin@tnacademy.test');
    const created = await http.post('/api/profile-change-requests').set(bearer(superToken))
      .send({ currentPassword: 'demo1234', webId: 'ceo_t31', verificationChallengeId: challengeId, reason: '대표 아이디 표기 정비입니다.' })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'approved', requestedChanges: { webId: 'ceo_t31' } });
    expect(db.findById<UserRow>('users', 3)!.webId).toBe('ceo_t31');
    await http.get('/api/auth/me').set(bearer(superToken)).expect(401); // 기존 세션 무효(재로그인 필요)
    await login('ceo_t31');
  });

  it('⑦ 프로필 변경 상시 OTP: 비연락처 변경 challenge 없이 400 → 본인 이메일 챌린지 소비로 201', async () => {
    const manager = await login('manager');
    await http.post('/api/profile-change-requests').set(bearer(manager))
      .send({ currentPassword: 'demo1234', name: '이지원 개명', reason: '본인 인증 없는 이름 변경 시도.' })
      .expect(400);
    // 본인(현재) 이메일로 verified된 challenge → 같은 tx 일회 소비 → 201 pending
    const challengeId = await forgeVerifiedEmailChallenge(app, 4, 'manager@tnacademy.test');
    const created = await http.post('/api/profile-change-requests').set(bearer(manager))
      .send({ currentPassword: 'demo1234', name: '이지원 개명', verificationChallengeId: challengeId, reason: '표시 이름 변경 요청입니다.' })
      .expect(201);
    expect(created.body).toMatchObject({ status: 'pending', requestedChanges: { name: '이지원 개명' } });
    expect(db.findById<Record<string, unknown>>('profile_verification_challenges', challengeId))
      .toMatchObject({ status: 'consumed', consumedByRequestId: created.body.id });
  });
});
