// [TBO-57 2026-07-24] 가입 전 휴대전화 OTP e2e — 대표 지시 "sms 인증 흐름(인증·재인증·성공/실패·
//  단일 진실원 가입 가능 여부) 반드시 검증하고 테스트코드 작성".
//  ① 기본 환경(SENS 미설정): signup-config=false·기존 가입 회귀·devOtpCode 전체 흐름(자발 소비).
//  ② fake SENS env + DI fake provider: signup-config=true·인증 없는 가입 400(단일 진실원)·발송이
//    provider로 나가고 코드 hash만 저장·오답 5회 잠금·쿨다운 재인증(supersede)·소비·재사용 400.
//  평문 코드·전화번호 마스킹 규약을 응답에서 검증한다.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import {
  CONTACT_VERIFICATION_PROVIDER,
  type CheckChallengeInput,
  type ContactVerificationProvider,
  type ProviderChallenge,
  type SendChallengeInput,
} from '../src/modules/profile-verifications/contact-verification.provider';
import { verifiedSignupChallenge, TEST_RRN } from './signup-helper';

type PhoneChallengeRow = {
  id: number; status: string; attemptCount: number; consumedByUserId?: number | null;
  phoneNormalized: string; codeHash: string;
};

// SENS형 fake — 코드 소유권=서비스(ownsCode false), send는 서비스 생성 코드를 기록만 한다(실 발송 0).
class FakeSensProvider implements ContactVerificationProvider {
  sent: Array<{ channel: string; target: string; code?: string }> = [];
  ownsCode(): boolean { return false; }
  async send(input: SendChallengeInput): Promise<ProviderChallenge> {
    this.sent.push({ channel: input.channel, target: input.target, code: input.code });
    return { provider: 'fake_test', providerReference: null };
  }
  async check(_input: CheckChallengeInput): Promise<{ ok: boolean }> { return { ok: false }; }
  lastCode(): string { return this.sent[this.sent.length - 1]?.code ?? ''; }
}

const PHONE = '010-4321-8765';
const PHONE_E164 = '+821043218765';

const signupBody = (webId: string, over: Record<string, unknown> = {}) => ({
  webId, name: `계정${webId}`, email: `${webId}@t57.test`, password: 'password123', rrn: TEST_RRN, ...over,
});

describe('[TBO-57] 가입 전 휴대전화 OTP — 기본 환경(SENS 미설정, devOtpCode)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  const challengeOf = (id: number) => db.findById<PhoneChallengeRow>('signup_phone_challenges', id)!;

  it('signup-config=false(단일 진실원) — 휴대전화 인증 없는 기존 가입 회귀 유지', async () => {
    const config = (await http.get('/api/auth/signup-config').expect(200)).body;
    expect(config).toEqual({ phoneVerificationRequired: false });
    const emailChallengeId = await verifiedSignupChallenge(http, 'p57_plain@t57.test');
    await http.post('/api/auth/signup')
      .send(signupBody('p57_plain', { email: 'p57_plain@t57.test', emailChallengeId, phone: PHONE }))
      .expect(201); // phoneChallengeId 없이도 가입(비필수 환경)
  });

  it('발송(devOtpCode·마스킹)→오답 5회 잠금→재인증(새 챌린지)→confirm→가입 자발 소비→재사용 400', async () => {
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone: PHONE }).expect(201)).body;
    expect(String(created.devOtpCode)).toMatch(/^\d{6}$/); // SENS 미설정 비prod — devOtpCode 관례
    expect(created.maskedTarget).not.toContain('43218765'); // E.164 canonical 미노출(마스킹만)
    expect(created.maskedTarget).toMatch(/^\+82\*+765$/);
    expect(challengeOf(created.id).phoneNormalized).toBe(PHONE_E164); // KR 로컬 → E.164 정규화
    expect(challengeOf(created.id).codeHash).not.toContain(String(created.devOtpCode)); // 평문 미저장

    // 실패 UX 계약: 오답은 GENERIC 400(존재 은닉) — 5회째 잠금 메시지로 전환
    for (let i = 0; i < 4; i += 1) {
      const res = await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
        .send({ phone: PHONE, code: '000000' }).expect(400);
      expect(res.body.message).toContain('유효하지 않거나 만료된');
    }
    const lockedRes = await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
      .send({ phone: PHONE, code: '000000' }).expect(400);
    expect(lockedRes.body.message).toContain('초과');
    expect(challengeOf(created.id).status).toBe('locked');
    // 잠긴 뒤엔 정답도 거부
    await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
      .send({ phone: PHONE, code: created.devOtpCode }).expect(400);

    // 재인증 = 새 챌린지(locked는 비활성 — 쿨다운 대상 아님)
    const fresh = (await http.post('/api/auth/signup-phone-challenge').send({ phone: PHONE }).expect(201)).body;
    // 전화 불일치 confirm → GENERIC 400(열거 방지)
    await http.post(`/api/auth/signup-phone-challenge/${fresh.id}/confirm`)
      .send({ phone: '010-9999-0000', code: fresh.devOtpCode }).expect(400);
    const confirmed = (await http.post(`/api/auth/signup-phone-challenge/${fresh.id}/confirm`)
      .send({ phone: PHONE, code: fresh.devOtpCode }).expect(201)).body;
    expect(confirmed).toEqual({ id: fresh.id, status: 'verified' });

    // 비필수 환경에서도 제출된 challenge는 같은 tx에서 소비된다(개발·e2e 전체 흐름 검증 경로)
    const emailChallengeId = await verifiedSignupChallenge(http, 'p57_vol@t57.test');
    const res = await http.post('/api/auth/signup')
      .send(signupBody('p57_vol', { email: 'p57_vol@t57.test', emailChallengeId, phone: PHONE, phoneChallengeId: fresh.id }))
      .expect(201);
    const userId = res.body.account.id as number;
    expect(challengeOf(fresh.id)).toMatchObject({ status: 'consumed', consumedByUserId: userId });

    // 소진 챌린지 재사용 가입 → 400 (일회성)
    const emailChallengeId2 = await verifiedSignupChallenge(http, 'p57_reuse@t57.test');
    await http.post('/api/auth/signup')
      .send(signupBody('p57_reuse', { email: 'p57_reuse@t57.test', emailChallengeId: emailChallengeId2, phone: PHONE, phoneChallengeId: fresh.id }))
      .expect(400);
  });

  it('쿨다운 400(60초 1회) + verified 없는 confirm·형식 오류 방어', async () => {
    const phone = '010-2222-3333';
    const first = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    const res = await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(400);
    expect(res.body.message).toContain('60초'); // 재전송 쿨다운 UX 계약
    // 다른 번호는 즉시 가능(번호별 카운터)
    await http.post('/api/auth/signup-phone-challenge').send({ phone: '010-2222-4444' }).expect(201);
    // 잘못된 형식·유령 id는 400 (GENERIC — 존재 은닉)
    await http.post('/api/auth/signup-phone-challenge').send({ phone: '1234' }).expect(400);
    await http.post(`/api/auth/signup-phone-challenge/99999/confirm`).send({ phone, code: '123456' }).expect(400);
    // pending 상태로 가입 소비 시도 → 400(verified만 소비 가능)
    const emailChallengeId = await verifiedSignupChallenge(http, 'p57_pend@t57.test');
    await http.post('/api/auth/signup')
      .send(signupBody('p57_pend', { email: 'p57_pend@t57.test', emailChallengeId, phone, phoneChallengeId: first.id }))
      .expect(400);
  });
});

describe('[TBO-57] 가입 전 휴대전화 OTP — SENS 설정 환경(필수 강제, DI fake)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const fake = new FakeSensProvider();
  const SENS_ENV = {
    NCP_SENS_ACCESS_KEY: 'test-access', NCP_SENS_SECRET_KEY: 'test-secret',
    NCP_SENS_SERVICE_ID: 'ncp:sms:kr:000000000000:test', NCP_SENS_FROM: '0212345678',
  } as const;

  beforeAll(async () => {
    Object.assign(process.env, SENS_ENV); // 가용성 판정(env) 활성 — 발송은 DI fake가 대체
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONTACT_VERIFICATION_PROVIDER)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => {
    for (const key of Object.keys(SENS_ENV)) delete process.env[key];
    await app.close();
  });

  const challengeOf = (id: number) => db.findById<PhoneChallengeRow>('signup_phone_challenges', id)!;

  it('단일 진실원: signup-config=true → 인증 없는 가입 400, verified 소비만 201', async () => {
    const config = (await http.get('/api/auth/signup-config').expect(200)).body;
    expect(config).toEqual({ phoneVerificationRequired: true }); // FE 스테퍼·submit 게이트와 같은 판정
    const email = 'p57_req@t57.test';
    const emailChallengeId = await verifiedSignupChallenge(http, email);
    // ① 전화 없음 → 400 ② 전화만 있고 인증 없음 → 400 (서버가 단일 진실원으로 강제)
    await http.post('/api/auth/signup').send(signupBody('p57_req', { email, emailChallengeId })).expect(400);
    const noChallenge = await http.post('/api/auth/signup')
      .send(signupBody('p57_req', { email, emailChallengeId, phone: PHONE })).expect(400);
    expect(noChallenge.body.message).toContain('휴대전화 인증');

    // 발송 — devOtpCode 없음(SENS 경로), 코드는 provider 캡처로만 확인(응답·저장 평문 0)
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone: PHONE }).expect(201)).body;
    expect(created.devOtpCode).toBeUndefined();
    expect(fake.sent[fake.sent.length - 1]).toMatchObject({ channel: 'sms', target: PHONE_E164 });
    const code = fake.lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(challengeOf(created.id).codeHash).not.toContain(code);

    // 성공 UX 계약: confirm → { id, status: 'verified' }
    await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
      .send({ phone: PHONE, code }).expect(201);

    // 이메일 OTP는 소비됐으므로 재발급 후 가입 — 같은 tx에서 phone challenge 소비
    const emailChallengeId2 = await verifiedSignupChallenge(http, email);
    const res = await http.post('/api/auth/signup')
      .send(signupBody('p57_req', { email, emailChallengeId: emailChallengeId2, phone: PHONE, phoneChallengeId: created.id }))
      .expect(201);
    expect(challengeOf(created.id)).toMatchObject({ status: 'consumed', consumedByUserId: res.body.account.id });
  });

  it('재인증(쿨다운 뒤 supersede): 구 pending 만료 처리 — 새 코드만 유효', async () => {
    const phone = '010-7777-8888';
    const first = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    const firstCode = fake.lastCode();
    // 쿨다운 강제 해제(테스트가 시간을 되돌린다) — [듀얼 모드] 서비스 refresh()가 권위 DB를
    //  재수화하므로 PG 모드에서는 메모리 조작만으론 부족, PG에도 써야 한다(profile-verification
    //  spec force() 규약과 동일. 종전 메모리 전용 조작은 PG 모드에서 재하이드레이션에 덮여
    //  쿨다운 400 → jest retryTimes 재실행이 첫 create까지 400으로 오염시키는 것을 실측).
    const past = new Date(Date.now() - 1000).toISOString();
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) await pg.query('UPDATE signup_phone_challenges SET resend_available_at = $1 WHERE id = $2', [past, first.id]);
    db.update('signup_phone_challenges', first.id, { resendAvailableAt: past } as never);
    const second = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    expect(challengeOf(first.id).status).toBe('expired'); // supersede — 재인증 규약
    // 구 코드로 새 챌린지 confirm → 400, 새 코드 → 201
    await http.post(`/api/auth/signup-phone-challenge/${second.id}/confirm`)
      .send({ phone, code: firstCode }).expect(400);
    await http.post(`/api/auth/signup-phone-challenge/${second.id}/confirm`)
      .send({ phone, code: fake.lastCode() }).expect(201);
  });

  it('가입 tx 원자성: phone challenge 소비 실패 시 계정 insert까지 롤백(부분 상태 0)', async () => {
    const email = 'p57_atomic@t57.test';
    const emailChallengeId = await verifiedSignupChallenge(http, email);
    const before = db.findAll<{ id: number }>('users').length;
    // 존재하지 않는 phoneChallengeId → 400, 계정 생성 0 (이메일 challenge 소비도 롤백)
    await http.post('/api/auth/signup')
      .send(signupBody('p57_atomic', { email, emailChallengeId, phone: PHONE, phoneChallengeId: 99999 }))
      .expect(400);
    expect(db.findAll<{ id: number }>('users').length).toBe(before);
    // 롤백 검증 — 같은 이메일 challenge로 정상 가입이 여전히 가능(소비 롤백 실증)
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone: PHONE }).expect(201)).body;
    await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
      .send({ phone: PHONE, code: fake.lastCode() }).expect(201);
    await http.post('/api/auth/signup')
      .send(signupBody('p57_atomic', { email, emailChallengeId, phone: PHONE, phoneChallengeId: created.id }))
      .expect(201);
  });
});
