// [TBO-31 C5] 비로그인 복구 OTP판 — 아이디 찾기(화면 표시)·비밀번호 재설정(즉시 변경) e2e.
//  규약(D7~D9): purpose 태그 일반화·교차 재생 차단(해시+purpose 이중)·recovery는 항상 발송·
//  결과는 이메일 소유를 OTP로 증명한 뒤에만 노출(열거 아님)·challenge 일회 소비(CAS)·
//  재설정 성공 = auth_version+1(기존 세션 전멸). PG 모드에서는 스위트별 fresh DB로 재실행(§18-5).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { verifiedSignupChallenge } from './signup-helper';

type ChallengeRow = {
  id: number; status: string; purpose?: string; consumedByUserId?: number | null; emailNormalized: string;
};

describe('Recovery OTP — 아이디 찾기·비밀번호 재설정 (e2e, TBO-31 C5)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (webId: string, password = 'demo1234') =>
    (await http.post('/api/auth/login').send({ webId, password }).expect(201)).body.accessToken as string;
  const challengeOf = (id: number) => db.findById<ChallengeRow>('signup_email_challenges', id)!;

  /** recovery challenge 발급 + devOtpCode confirm → verified id 반환 */
  const verifiedRecoveryChallenge = async (email: string): Promise<number> => {
    const created = (await http.post('/api/auth/recovery-email-challenge').send({ email }).expect(201)).body;
    await http.post(`/api/auth/recovery-email-challenge/${created.id}/confirm`)
      .send({ email, code: created.devOtpCode }).expect(201);
    return created.id as number;
  };

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  it('① 발송: 가입/미가입 이메일 모두 동일 shape 201 + devOtpCode(recovery는 항상 발송 — D8)', async () => {
    // manager 이메일 사용 — ②의 park 검증과 이메일을 분리(60초 쿨다운은 email+purpose 단위).
    const registered = (await http.post('/api/auth/recovery-email-challenge')
      .send({ email: 'manager@tnacademy.test' }).expect(201)).body;
    const unknown = (await http.post('/api/auth/recovery-email-challenge')
      .send({ email: 'nobody@t31c5.test' }).expect(201)).body;
    expect(String(registered.devOtpCode)).toMatch(/^\d{6}$/);
    expect(String(unknown.devOtpCode)).toMatch(/^\d{6}$/);
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(registered).sort()); // 응답 shape 동일(열거 방지)
    expect(challengeOf(registered.id).purpose).toBe('recovery');
    // 평문 코드는 저장되지 않는다(hash만)
    expect(JSON.stringify(challengeOf(registered.id))).not.toContain(String(registered.devOtpCode));
  });

  it('② 아이디 찾기: verified 소비 → webIds 표시 · 재호출 400(일회 소비) · 미가입은 빈 배열', async () => {
    const challengeId = await verifiedRecoveryChallenge('park@tnacademy.test');
    const res = await http.post('/api/auth/recover-id/complete')
      .send({ challengeId, email: 'park@tnacademy.test' }).expect(201);
    expect(res.body).toEqual({ webIds: ['park_inst'] });
    expect(challengeOf(challengeId)).toMatchObject({ status: 'consumed', consumedByUserId: 1 });
    // 이중 소비 — 같은 challenge 재호출 400
    await http.post('/api/auth/recover-id/complete')
      .send({ challengeId, email: 'park@tnacademy.test' }).expect(400);

    // 미가입 이메일 — 인증까지 되면 '계정 없음'(빈 배열)도 소비 성립(consumed_by_user_id NULL 허용)
    const ghostId = await verifiedRecoveryChallenge('ghost@t31c5.test');
    const ghost = await http.post('/api/auth/recover-id/complete')
      .send({ challengeId: ghostId, email: 'ghost@t31c5.test' }).expect(201);
    expect(ghost.body).toEqual({ webIds: [] });
    expect(challengeOf(ghostId)).toMatchObject({ status: 'consumed', consumedByUserId: null });
  });

  it('③ 미인증(pending)·이메일 불일치 complete → 400(GENERIC·소비 없음)', async () => {
    const created = (await http.post('/api/auth/recovery-email-challenge')
      .send({ email: 'pending@t31c5.test' }).expect(201)).body;
    await http.post('/api/auth/recover-id/complete')
      .send({ challengeId: created.id, email: 'pending@t31c5.test' }).expect(400);
    expect(challengeOf(created.id).status).toBe('pending');

    const verified = await verifiedRecoveryChallenge('mismatch@t31c5.test');
    await http.post('/api/auth/recover-id/complete')
      .send({ challengeId: verified, email: 'other@t31c5.test' }).expect(400);
    expect(challengeOf(verified).status).toBe('verified'); // 불일치는 소비하지 않는다
  });

  it('④ 교차 재생 차단: signup 목적 challenge로 recovery confirm/complete → 400', async () => {
    // signup용 verified challenge — recovery 완료 단계에 투입 시 purpose 불일치 400
    const signupChallengeId = await verifiedSignupChallenge(http, 'crossuse@t31c5.test');
    await http.post('/api/auth/recover-id/complete')
      .send({ challengeId: signupChallengeId, email: 'crossuse@t31c5.test' }).expect(400);
    expect(challengeOf(signupChallengeId).status).toBe('verified'); // 소비되지 않음

    // signup 발송 코드로 recovery confirm 시도 — purpose 불일치(missing 취급) + 해시 프리픽스 상이
    const created = (await http.post('/api/auth/signup-email-challenge')
      .send({ email: 'crosscode@t31c5.test' }).expect(201)).body;
    await http.post(`/api/auth/recovery-email-challenge/${created.id}/confirm`)
      .send({ email: 'crosscode@t31c5.test', code: created.devOtpCode }).expect(400);
  });

  it('⑤ 비밀번호 재설정: 3중 일치 시 변경 + auth_version+1(구 토큰 401·새 비밀번호 로그인)', async () => {
    const oldToken = await login('jung_inst'); // 재설정 전 세션 — 전멸 대상
    const challengeId = await verifiedRecoveryChallenge('jung@tnacademy.test');

    // webId 불일치 — 소비 없이 400(재시도 가능·이메일 소유 증명 후라 본인 정보 이상 노출 없음)
    await http.post('/api/auth/reset-password-otp')
      .send({ challengeId, webId: 'park_inst', email: 'jung@tnacademy.test', newPassword: 'newpass1234' })
      .expect(400);
    expect(challengeOf(challengeId).status).toBe('verified');

    // 정상 — 같은 challenge로 재시도 성공
    await http.post('/api/auth/reset-password-otp')
      .send({ challengeId, webId: 'jung_inst', email: 'jung@tnacademy.test', newPassword: 'newpass1234' })
      .expect(201);
    expect(challengeOf(challengeId)).toMatchObject({ status: 'consumed', consumedByUserId: 2 });

    await http.get('/api/auth/me').set(bearer(oldToken)).expect(401); // 기존 세션 전멸(auth_version+1)
    await http.post('/api/auth/login').send({ webId: 'jung_inst', password: 'demo1234' }).expect(401); // 구 비밀번호 불가
    await login('jung_inst', 'newpass1234'); // 새 비밀번호 로그인

    // 소진된 challenge 재사용 → 400(이중 소비 차단)
    await http.post('/api/auth/reset-password-otp')
      .send({ challengeId, webId: 'jung_inst', email: 'jung@tnacademy.test', newPassword: 'again12345' })
      .expect(400);
    await login('jung_inst', 'newpass1234'); // 비밀번호는 그대로
  });

  it('⑥ 재설정 검증: 8바이트 미만 400 · 미인증 challenge 400 · 비활성/미가입 계정 400', async () => {
    const challengeId = await verifiedRecoveryChallenge('short@t31c5.test');
    await http.post('/api/auth/reset-password-otp')
      .send({ challengeId, webId: 'park_inst', email: 'short@t31c5.test', newPassword: 'a1b2c3' })
      .expect(400); // DTO MinLength(8)

    // 미가입 이메일 — 인증은 됐지만 대조 계정 없음 → 400, challenge 미소비
    await http.post('/api/auth/reset-password-otp')
      .send({ challengeId, webId: 'no_such_id', email: 'short@t31c5.test', newPassword: 'validpass123' })
      .expect(400);
    expect(challengeOf(challengeId).status).toBe('verified');

    // pending(미인증) challenge → 400
    const created = (await http.post('/api/auth/recovery-email-challenge')
      .send({ email: 'park@tnacademy.test' }).expect(201)).body;
    await http.post('/api/auth/reset-password-otp')
      .send({ challengeId: created.id, webId: 'park_inst', email: 'park@tnacademy.test', newPassword: 'validpass123' })
      .expect(400);
  });
});
