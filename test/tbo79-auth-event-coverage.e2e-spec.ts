// [TBO-79 F5 2026-07-30] auth_events 전수 readback.
//
//  결함: 9개 event type 중 3개(`recover_id_completed`·`password_reset_requested`·
//  `password_reset_completed`)와 login_failure 6개 코드 중 4개가 **어떤 테스트에서도 단언되지
//  않았다**. `record()`가 모든 예외를 삼키므로(warn 로그만) DB 쓰기가 조용히 실패해도
//  아무도 모른다 — 보안 이력이 비어 있는 걸 알아챌 장치가 없었다.
//
//  이 스위트는 각 흐름을 실제로 구동한 뒤 auth_events 행을 직접 읽어 못박는다.
//  refresh **성공**은 의도적으로 "이벤트 없음"을 단언한다 — 계약에 해당 타입이 없다는 현실을
//  고정하기 위해서다(신설 여부는 owner 결정, TBO-79 §6).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { USERS, type StaffAccount } from '../src/modules/users/user.entity';

jest.setTimeout(30000);

type AuthEventRow = {
  eventType: string;
  userId?: number | null;
  attemptedWebIdHash?: string | null;
  success?: boolean;
  failureCode?: string | null;
  at: string;
};

describe('[TBO-79] auth_events 전수 readback (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  const events = () => db.findAll<AuthEventRow>('auth_events');
  /** 직전 호출 이후 새로 생긴 행만 본다 — 스위트 간 누적에 흔들리지 않게. */
  const since = (mark: number) => events().slice(mark);
  const mark = () => events().length;
  const accountOf = (webId: string) => db.findBy<StaffAccount>(USERS, (a) => a.webId === webId)[0];

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => { await app.close(); });

  it('F5 — login_success: userId·success·시각이 기록된다', async () => {
    const before = mark();
    const startedAt = Date.now();
    await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201);
    const fresh = since(before).filter((row) => row.eventType === 'login_success');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].userId).toBe(accountOf('manager').id);
    expect(fresh[0].success).toBe(true);
    expect(Date.parse(fresh[0].at)).toBeGreaterThanOrEqual(startedAt - 1000);
  });

  it('F5 — login_failure: 계정 상태별 failureCode가 전부 구분 기록된다', async () => {
    // 픽스처는 전부 active·verified라 상태 코드를 직접 만든다(원복 포함).
    const inst = accountOf('jung_inst');
    const original = { status: inst.status, emailVerified: inst.emailVerified };

    // demo_credential_blocked 는 production 모드 + Origin 헤더가 필요해 auth.e2e-spec 이 전담한다.
    const cases: Array<{ code: string; setup?: () => void; webId: string; password: string }> = [
      { code: 'bad_credentials', webId: 'jung_inst', password: 'definitely-wrong-9999' },
      { code: 'email_unverified', webId: 'jung_inst', password: 'demo1234',
        setup: () => { inst.emailVerified = false; } },
      { code: 'pending_approval', webId: 'jung_inst', password: 'demo1234',
        setup: () => { inst.emailVerified = true; inst.status = 'pending'; } },
      { code: 'rejected', webId: 'jung_inst', password: 'demo1234',
        setup: () => { inst.status = 'rejected'; } },
    ];

    const seen: string[] = [];
    for (const testCase of cases) {
      const before = mark();
      const previousEnv = process.env.NODE_ENV;
      testCase.setup?.();
      const res = await http.post('/api/auth/login').send({ webId: testCase.webId, password: testCase.password });
      process.env.NODE_ENV = previousEnv;
      expect([401, 403]).toContain(res.status);
      const fresh = since(before).filter((row) => row.eventType === 'login_failure');
      expect(fresh).toHaveLength(1);
      expect(fresh[0].success).toBe(false);
      // webId 원문은 저장되지 않는다 — sha256 해시만.
      expect(fresh[0].attemptedWebIdHash).toMatch(/^[a-f0-9]{64}$/);
      expect(fresh[0].attemptedWebIdHash).not.toContain('jung_inst');
      seen.push(String(fresh[0].failureCode));
    }
    inst.status = original.status;
    inst.emailVerified = original.emailVerified;

    expect(seen).toEqual(['bad_credentials', 'email_unverified', 'pending_approval', 'rejected']);
    // demo_credential_blocked 는 별도 스위트가 고정한다(production 전용 경로).
    expect(events().some((row) => row.failureCode === 'demo_credential_blocked')).toBe(false);
    // 원복 확인 — 후속 스위트가 이 계정으로 로그인할 수 있어야 한다.
    await http.post('/api/auth/login').send({ webId: 'jung_inst', password: 'demo1234' }).expect(201);
  });

  it('F5 — logout: refresh 폐기와 함께 기록된다', async () => {
    const login = await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201);
    const cookies = login.get('Set-Cookie') ?? [];
    const before = mark();
    await http.post('/api/auth/logout').set('Cookie', cookies).send({}).expect(201);
    const fresh = since(before).filter((row) => row.eventType === 'logout');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].success).toBe(true);
  });

  it('F5 — recover_id_requested / recover_id_completed 가 모두 기록된다', async () => {
    const email = accountOf('admin').email!;
    let before = mark();
    await http.post('/api/auth/recover-id').send({ email }).expect(201);
    expect(since(before).filter((row) => row.eventType === 'recover_id_requested')).toHaveLength(1);

    // OTP 판 — 발송 후 dev 코드로 확인하면 recover_id_completed 가 남는다.
    //  같은 이메일은 60초 쿨다운이 걸리므로 위 recover-id 와 다른 계정 이메일을 쓴다.
    const otpEmail = accountOf('park_inst').email!;
    // 부팅 시드/선행 흐름이 같은 이메일로 pending 챌린지를 남겨두면 60초 쿨다운에 걸린다.
    //  이 스위트의 관심사는 이벤트 기록이지 쿨다운이 아니므로, 잔존 pending을 만료 처리해
    //  시작 상태를 결정론으로 만든다(쿨다운 자체는 signup OTP 스위트가 별도로 고정한다).
    for (const row of db.findAll<{ id: number; emailNormalized?: string; status?: string }>('signup_email_challenges')) {
      if (row.emailNormalized === otpEmail.toLowerCase() && row.status === 'pending') row.status = 'expired';
    }
    const challenge = (await http.post('/api/auth/recovery-email-challenge').send({ email: otpEmail }).expect(201))
      .body as { id: number; devOtpCode?: string };
    expect(String(challenge.devOtpCode)).toMatch(/^\d{6}$/);
    await http.post(`/api/auth/recovery-email-challenge/${challenge.id}/confirm`)
      .send({ email: otpEmail, code: challenge.devOtpCode }).expect(201);
    before = mark();
    const completed = await http.post('/api/auth/recover-id/complete')
      .send({ email: otpEmail, challengeId: challenge.id }).expect(201);
    expect(completed.body.webIds).toEqual(expect.arrayContaining(['park_inst']));
    const fresh = since(before).filter((row) => row.eventType === 'recover_id_completed');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].success).toBe(true);
  });

  it('F5 — password_reset_requested / password_reset_completed 가 모두 기록된다', async () => {
    const email = accountOf('admin').email!;
    let before = mark();
    const issued = (await http.post('/api/auth/recover-password').send({ webId: 'admin', email }).expect(201)).body as {
      devResetUrl?: string;
    };
    expect(since(before).filter((row) => row.eventType === 'password_reset_requested')).toHaveLength(1);

    const token = new URL(String(issued.devResetUrl)).searchParams.get('token')!;
    before = mark();
    await http.post('/api/auth/reset-password').send({ token, newPassword: 'tbo79-reset-pass' }).expect(201);
    const fresh = since(before).filter((row) => row.eventType === 'password_reset_completed');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].userId).toBe(accountOf('admin').id);
    expect(fresh[0].success).toBe(true);

    // 원복 — 후속 스위트가 demo1234로 로그인한다.
    const back = (await http.post('/api/auth/recover-password').send({ webId: 'admin', email }).expect(201)).body as {
      devResetUrl?: string;
    };
    const backToken = new URL(String(back.devResetUrl)).searchParams.get('token')!;
    await http.post('/api/auth/reset-password').send({ token: backToken, newPassword: 'demo1234' }).expect(201);
    await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
  });

  it('F5 — refresh_reuse_blocked: 구 refresh 재사용이 보안 이벤트로 남는다', async () => {
    const login = await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201);
    const first = login.get('Set-Cookie') ?? [];
    // 1회 회전 — 구 토큰은 이 시점에 폐기된다.
    await http.post('/api/auth/refresh').set('Cookie', first).send({}).expect(201);
    const before = mark();
    await http.post('/api/auth/refresh').set('Cookie', first).send({}).expect(401);
    const fresh = since(before).filter((row) => row.eventType === 'refresh_reuse_blocked');
    expect(fresh).toHaveLength(1);
    expect(fresh[0].success).toBe(false);
  });

  it('F5 — refresh **성공**은 이벤트를 남기지 않는다(현재 계약에 타입 없음 — owner 결정 대기)', async () => {
    const login = await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201);
    const cookies = login.get('Set-Cookie') ?? [];
    const before = mark();
    await http.post('/api/auth/refresh').set('Cookie', cookies).send({}).expect(201);
    // 이 단언은 "바람직하다"가 아니라 **현재 사실**을 고정한다. 타입을 신설하기로 결정하면
    // 이 테스트가 빨간불이 되어 함께 고치도록 강제한다.
    expect(since(before)).toHaveLength(0);
  });

  it('F5 — 기록된 어떤 이벤트에도 평문 자격증명이 없다', async () => {
    const serialized = JSON.stringify(events());
    for (const secret of ['demo1234', 'tbo79-reset-pass', 'definitely-wrong-9999']) {
      expect(serialized).not.toContain(secret);
    }
    // 계약에 선언된 타입만 저장된다.
    const declared = new Set([
      'login_success', 'login_failure', 'logout',
      'recover_id_requested', 'recover_id_completed',
      'password_reset_requested', 'password_reset_completed',
      'refresh_reuse_blocked', 'csrf_origin_blocked',
    ]);
    const unexpected = [...new Set(events().map((row) => row.eventType))].filter((type) => !declared.has(type));
    expect(unexpected).toEqual([]);
  });
});
