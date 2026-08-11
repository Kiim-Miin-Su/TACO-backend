// [TBO-57 2026-07-24] 가입 전 휴대전화 OTP e2e — 대표 지시 "sms 인증 흐름(인증·재인증·성공/실패·
//  단일 진실원 가입 가능 여부) 반드시 검증하고 테스트코드 작성".
//  ① 기본 환경(SENS 미설정): signup-config=false·기존 가입 회귀·devOtpCode 전체 흐름(자발 소비).
//  ② fake SENS env + DI fake provider: signup-config=true·인증 없는 가입 400(단일 진실원)·발송이
//    provider로 나가고 코드 hash만 저장·오답 5회 잠금·쿨다운 재인증(supersede)·소비·재사용 400.
//  평문 코드·전화번호 마스킹 규약을 응답에서 검증한다.
//
// [TBO-62 후속 재작성 2026-07-24] retry-안전화(대표 지시 "테스트코드 재작성") — 종전엔 전 테스트가
//  고정 전화번호(PHONE)·webId를 공유해, 1회성 소켓 플레이크(기지 사례 — jest-e2e.after 참조) 후
//  retryTimes(1) 재실행이 잔존 상태(쿨다운 60초·중복 webId 가입 400·소진 챌린지)에 부딪혀 연쇄
//  실패할 수 있었다(2026-07-24 release 실측: 첫 실패 후 재시도가 오염된 상태에서 시작). 해결 =
//  테스트 **시도마다** 유일한 전화번호·계정 팩토리(nextPhone/nextUser) — 어떤 테스트도 이전 시도·
//  다른 테스트의 상태에 의존하지 않는다. 거대 단일 플로우도 4개 테스트로 분할해 재실행 표면 축소.
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/configure-app';
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

// ── retry-안전 유일값 팩토리 — 호출(=시도)마다 새 전화·계정: 쿨다운/중복 가입 상태 격리 ──
let seq = 0;
const nextPhone = () => {
  seq += 1;
  return `010-4${String(100 + seq).slice(-3)}-${String(8000 + seq)}`; // 010-4101-8001, 010-4102-8002, …
};
const e164Of = (phone: string) => `+82${phone.replace(/-/g, '').slice(1)}`;
const last3Of = (phone: string) => phone.replace(/-/g, '').slice(-3);
const nextUser = (prefix: string) => {
  seq += 1;
  const webId = `p57_${prefix}${seq}`;
  return { webId, email: `${webId}@t57.test` };
};

const signupBody = (webId: string, over: Record<string, unknown> = {}) => ({
  webId, name: `계정${webId}`, email: `${webId}@t57.test`, password: 'password123', rrn: TEST_RRN, ...over,
});

// 오답 4회(GENERIC 400) + 5회째 잠금 메시지 → locked 상태까지 몰아넣는 공용 절차.
async function lockChallenge(http: ReturnType<typeof request>, id: number, phone: string): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const res = await http.post(`/api/auth/signup-phone-challenge/${id}/confirm`)
      .send({ phone, code: '000000' }).expect(400);
    expect(res.body.message).toContain('유효하지 않거나 만료된');
  }
  const lockedRes = await http.post(`/api/auth/signup-phone-challenge/${id}/confirm`)
    .send({ phone, code: '000000' }).expect(400);
  expect(lockedRes.body.message).toContain('초과');
}

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
    const { webId, email } = nextUser('plain');
    const phone = nextPhone();
    const emailChallengeId = await verifiedSignupChallenge(http, email);
    await http.post('/api/auth/signup')
      .send(signupBody(webId, { email, emailChallengeId, phone }))
      .expect(201); // phoneChallengeId 없이도 가입(비필수 환경)

    const before = db.findAll<PhoneChallengeRow>('signup_phone_challenges').length;
    const duplicate = await http.post('/api/auth/signup-phone-challenge')
      .send({ phone: e164Of(phone) }).expect(409);
    expect(duplicate.body).toMatchObject({
      code: 'SIGNUP_PHONE_ALREADY_REGISTERED',
      message: '이미 가입된 휴대폰입니다.',
    });
    expect(db.findAll<PhoneChallengeRow>('signup_phone_challenges')).toHaveLength(before);
  });

  it('발송 — devOtpCode 관례·마스킹·E.164 정규화·평문 미저장', async () => {
    const phone = nextPhone();
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    expect(String(created.devOtpCode)).toMatch(/^\d{6}$/); // SENS 미설정 비prod — devOtpCode 관례
    expect(created.maskedTarget).toMatch(new RegExp(`^\\+82\\*+${last3Of(phone)}$`)); // 마스킹만(원문 미노출)
    expect(challengeOf(created.id).phoneNormalized).toBe(e164Of(phone)); // KR 로컬 → E.164 정규화
    expect(challengeOf(created.id).codeHash).not.toContain(String(created.devOtpCode)); // 평문 미저장
  });

  it('오답 5회 잠금 — GENERIC 400(존재 은닉) → 잠금 메시지 전환 → 잠긴 뒤 정답도 거부', async () => {
    const phone = nextPhone();
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    await lockChallenge(http, created.id, phone);
    expect(challengeOf(created.id).status).toBe('locked');
    await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
      .send({ phone, code: created.devOtpCode }).expect(400); // 잠긴 뒤엔 정답도 거부
  });

  it('잠금 후 재인증(새 챌린지·쿨다운 비대상) → 전화 불일치 400 → confirm → 가입 자발 소비 → 재사용 400', async () => {
    const phone = nextPhone();
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    await lockChallenge(http, created.id, phone);

    // 재인증 = 새 챌린지(locked는 비활성 — 쿨다운 대상 아님)
    const fresh = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    // 전화 불일치 confirm → GENERIC 400(열거 방지)
    await http.post(`/api/auth/signup-phone-challenge/${fresh.id}/confirm`)
      .send({ phone: nextPhone(), code: fresh.devOtpCode }).expect(400);
    const confirmed = (await http.post(`/api/auth/signup-phone-challenge/${fresh.id}/confirm`)
      .send({ phone, code: fresh.devOtpCode }).expect(201)).body;
    expect(confirmed).toEqual({ id: fresh.id, status: 'verified' });

    // 비필수 환경에서도 제출된 challenge는 같은 tx에서 소비된다(개발·e2e 전체 흐름 검증 경로)
    const vol = nextUser('vol');
    const emailChallengeId = await verifiedSignupChallenge(http, vol.email);
    const res = await http.post('/api/auth/signup')
      .send(signupBody(vol.webId, { email: vol.email, emailChallengeId, phone, phoneChallengeId: fresh.id }))
      .expect(201);
    const userId = res.body.account.id as number;
    expect(challengeOf(fresh.id)).toMatchObject({ status: 'consumed', consumedByUserId: userId });

    // 같은 번호 재가입은 OTP 재사용 판정보다 앞선 연락처 중복 게이트에서 409.
    const reuse = nextUser('reuse');
    const emailChallengeId2 = await verifiedSignupChallenge(http, reuse.email);
    const replay = await http.post('/api/auth/signup')
      .send(signupBody(reuse.webId, { email: reuse.email, emailChallengeId: emailChallengeId2, phone, phoneChallengeId: fresh.id }))
      .expect(409);
    expect(replay.body.code).toBe('SIGNUP_PHONE_ALREADY_REGISTERED');
  });

  it('쿨다운 400(60초 1회) + verified 없는 confirm·형식 오류 방어', async () => {
    const phone = nextPhone();
    const first = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    const res = await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(400);
    expect(res.body.message).toContain('60초'); // 재전송 쿨다운 UX 계약
    // 다른 번호는 즉시 가능(번호별 카운터)
    await http.post('/api/auth/signup-phone-challenge').send({ phone: nextPhone() }).expect(201);
    // 잘못된 형식·유령 id는 400 (GENERIC — 존재 은닉)
    await http.post('/api/auth/signup-phone-challenge').send({ phone: '1234' }).expect(400);
    await http.post(`/api/auth/signup-phone-challenge/99999/confirm`).send({ phone, code: '123456' }).expect(400);
    // pending 상태로 가입 소비 시도 → 400(verified만 소비 가능)
    const pend = nextUser('pend');
    const emailChallengeId = await verifiedSignupChallenge(http, pend.email);
    await http.post('/api/auth/signup')
      .send(signupBody(pend.webId, { email: pend.email, emailChallengeId, phone, phoneChallengeId: first.id }))
      .expect(400);
  });
});

describe('[TBO-57] 가입 전 휴대전화 OTP — SENS 설정 환경(필수 강제, DI fake)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const fake = new FakeSensProvider();
  const SENS_ENV = {
    NCP_SENS_ACCESS_KEY_ID: 'test-access', NCP_SENS_SECRET_KEY: 'test-secret',
    NCP_SENS_SERVICE_ID: 'ncp:sms:kr:000000000000:test', NCP_SENS_FROM: '0212345678',
  } as const;

  beforeAll(async () => {
    Object.assign(process.env, SENS_ENV); // 가용성 판정(env) 활성 — 발송은 DI fake가 대체
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONTACT_VERIFICATION_PROVIDER)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app, { cors: false, observability: false });
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
    const { webId, email } = nextUser('req');
    const phone = nextPhone();
    const emailChallengeId = await verifiedSignupChallenge(http, email);
    // ① 전화 없음 → 400 ② 전화만 있고 인증 없음 → 400 (서버가 단일 진실원으로 강제)
    await http.post('/api/auth/signup').send(signupBody(webId, { email, emailChallengeId })).expect(400);
    const noChallenge = await http.post('/api/auth/signup')
      .send(signupBody(webId, { email, emailChallengeId, phone })).expect(400);
    expect(noChallenge.body.message).toContain('휴대전화 인증');

    // 발송 — devOtpCode 없음(SENS 경로), 코드는 provider 캡처로만 확인(응답·저장 평문 0)
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    expect(created.devOtpCode).toBeUndefined();
    expect(fake.sent[fake.sent.length - 1]).toMatchObject({ channel: 'sms', target: e164Of(phone) });
    const code = fake.lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(challengeOf(created.id).codeHash).not.toContain(code);

    // 성공 UX 계약: confirm → { id, status: 'verified' }
    await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
      .send({ phone, code }).expect(201);

    // 이메일 OTP는 소비됐으므로 재발급 후 가입 — 같은 tx에서 phone challenge 소비
    const emailChallengeId2 = await verifiedSignupChallenge(http, email);
    const res = await http.post('/api/auth/signup')
      .send(signupBody(webId, { email, emailChallengeId: emailChallengeId2, phone, phoneChallengeId: created.id }))
      .expect(201);
    expect(challengeOf(created.id)).toMatchObject({ status: 'consumed', consumedByUserId: res.body.account.id });
    const sentBeforeDuplicate = fake.sent.length;
    const duplicate = await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(409);
    expect(duplicate.body.message).toBe('이미 가입된 휴대폰입니다.');
    expect(fake.sent).toHaveLength(sentBeforeDuplicate); // 중복이면 provider 호출 0
  });

  it('재인증(쿨다운 뒤 supersede): 구 pending 만료 처리 — 새 코드만 유효', async () => {
    const phone = nextPhone();
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
    const { webId, email } = nextUser('atomic');
    const phone = nextPhone();
    const emailChallengeId = await verifiedSignupChallenge(http, email);
    const before = db.findAll<{ id: number }>('users').length;
    // 존재하지 않는 phoneChallengeId → 400, 계정 생성 0 (이메일 challenge 소비도 롤백)
    await http.post('/api/auth/signup')
      .send(signupBody(webId, { email, emailChallengeId, phone, phoneChallengeId: 99999 }))
      .expect(400);
    expect(db.findAll<{ id: number }>('users').length).toBe(before);
    // 롤백 검증 — 같은 이메일 challenge로 정상 가입이 여전히 가능(소비 롤백 실증)
    const created = (await http.post('/api/auth/signup-phone-challenge').send({ phone }).expect(201)).body;
    await http.post(`/api/auth/signup-phone-challenge/${created.id}/confirm`)
      .send({ phone, code: fake.lastCode() }).expect(201);
    await http.post('/api/auth/signup')
      .send(signupBody(webId, { email, emailChallengeId, phone, phoneChallengeId: created.id }))
      .expect(201);
  });
});
