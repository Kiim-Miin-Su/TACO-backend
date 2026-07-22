// [TBO-29B-4 V4] 연락처 재인증 e2e — 발송/확인/재전송/소비 전 규칙.
//  provider는 deterministic fake를 DI로 주입(실 발송 0 — §4). 실제 provider smoke는 opt-in 별도.
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/modules/audit/audit.service';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { camelToSnake } from '../src/database/postgres-row.util';
import {
  CONTACT_VERIFICATION_PROVIDER,
  type CheckChallengeInput,
  type ContactVerificationProvider,
  type ProviderChallenge,
  type SendChallengeInput,
} from '../src/modules/profile-verifications/contact-verification.provider';
import { seedBusinessFixtures } from './fixtures/seed-business-fixtures';

class FakeContactVerificationProvider implements ContactVerificationProvider {
  sent: Array<{ channel: string; target: string; code?: string }> = [];
  failNextSend = false;
  // Twilio Verify형 fake — sms 코드는 provider 소유(check 위임 경로 회귀 유지). SENS형은 별도 스펙.
  ownsCode(channel: 'email' | 'sms'): boolean {
    return channel === 'sms';
  }
  async send(input: SendChallengeInput): Promise<ProviderChallenge> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('injected provider failure');
    }
    this.sent.push({ channel: input.channel, target: input.target, code: input.code });
    return { provider: 'fake_test', providerReference: input.channel === 'sms' ? `fake-${this.sent.length}` : null };
  }
  async check(input: CheckChallengeInput): Promise<{ ok: boolean }> {
    return { ok: input.code === '424242' }; // SMS 채널의 deterministic 정답 코드
  }
  lastCode(): string {
    return this.sent[this.sent.length - 1]?.code ?? '';
  }
}

type ChallengeRow = {
  id: number; requesterId: number; status: string; attemptCount: number;
  expiresAt: string; resendAvailableAt: string; consumedByRequestId?: number | null;
  targetNormalized: string; codeHash?: string | null;
};
type RequestRow = { id: number; requesterId: number; status: string; requestedChanges: Record<string, unknown>; verificationChallengeId?: number | null };
type UserRow = { id: number; email?: string | null; phone?: string | null; profileVersion: number };

describe('Profile contact verification (e2e, TBO-29B-4)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const fake = new FakeContactVerificationProvider();
  const tokens: Record<string, string> = {};

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken as string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CONTACT_VERIFICATION_PROVIDER)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    seedBusinessFixtures(app);
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    tokens.instructor = await login('park_inst');
    tokens.foreign = await login('jung_inst');
    tokens.manager = await login('manager');
  });
  afterAll(async () => { await app.close(); });

  const challengeOf = (id: number) => db.findById<ChallengeRow & { id: number }>('profile_verification_challenges', id)!;
  // [듀얼 모드] Postgres 모드에서는 서비스가 권위 DB를 재조회하므로 테스트 조작도 DB에 써야 한다.
  const force = async (table: string, id: number, patch: Record<string, unknown>) => {
    const pg = app.get(PostgresConnectionService);
    if (pg.ready) {
      const keys = Object.keys(patch);
      const sets = keys.map((k, i) => `${camelToSnake(k)} = $${i + 1}`);
      await pg.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map((k) => patch[k]), id]);
    }
    db.update(table, id, patch as never);
  };
  const requestCount = () => db.findAll<RequestRow & { id: number }>('profile_change_requests').length;

  async function makeVerifiedEmailChallenge(token: string, target: string): Promise<number> {
    const created = (await http.post('/api/profile-verifications').set(bearer(token))
      .send({ currentPassword: 'demo1234', channel: 'email', target }).expect(201)).body;
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(token))
      .send({ code: fake.lastCode() }).expect(201);
    return created.id as number;
  }

  it('발송: 비밀번호 재확인·형식·중복 검사 + 응답은 masked만', async () => {
    await http.post('/api/profile-verifications').set(bearer(tokens.instructor))
      .send({ currentPassword: 'wrong-password', channel: 'email', target: 'new@t.test' }).expect(403);
    await http.post('/api/profile-verifications').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'not-an-email' }).expect(400);
    await http.post('/api/profile-verifications').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', channel: 'sms', target: '12' }).expect(400);
    // 중복: jung의 시드 이메일
    await http.post('/api/profile-verifications').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'JUNG@tnacademy.test' }).expect(409);

    const created = (await http.post('/api/profile-verifications').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'Park.New@TnAcademy.test' }).expect(201)).body;
    expect(created.status).toBe('pending');
    expect(created.maskedTarget).not.toContain('park.new@tnacademy.test');
    expect(JSON.stringify(created)).not.toContain('park.new@tnacademy.test'); // canonical 미노출
    expect(fake.sent[fake.sent.length - 1]).toMatchObject({ channel: 'email', target: 'park.new@tnacademy.test' });
    expect(fake.lastCode()).toMatch(/^\d{6}$/);
    // 평문 코드는 저장되지 않는다(hash만)
    expect(challengeOf(created.id).codeHash).not.toBe(fake.lastCode());
  });

  it('확인: 오코드 실패 카운터 영속(rollback 아님) → 정답 시 verified, 5회 실패 시 잠금', async () => {
    // park의 활성 email challenge는 위 테스트에서 생성됨 — 같은 채널 재발송은 대체(supersede)
    const created = (await http.post('/api/profile-verifications').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'park.new@tnacademy.test' }).expect(201)).body;
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.instructor))
      .send({ code: '000000' }).expect(400);
    expect(challengeOf(created.id).attemptCount).toBe(1); // 실패가 커밋됨
    // wrong-owner — 열거 방지 일반화(404 아님 400)
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.foreign))
      .send({ code: fake.lastCode() }).expect(400);
    expect(challengeOf(created.id).attemptCount).toBe(1); // 타인 시도는 카운터 불변
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.instructor))
      .send({ code: fake.lastCode() }).expect(201);
    expect(challengeOf(created.id).status).toBe('verified');
    // verified 상태에서 재확인 시도 → 일반화 400
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.instructor))
      .send({ code: fake.lastCode() }).expect(400);

    // 잠금: 새 challenge에서 5회 오입력
    const locked = (await http.post('/api/profile-verifications').set(bearer(tokens.manager))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'manager.new@tnacademy.test' }).expect(201)).body;
    for (let i = 0; i < 5; i += 1) {
      await http.post(`/api/profile-verifications/${locked.id}/confirm`).set(bearer(tokens.manager))
        .send({ code: '999999' }).expect(400);
    }
    expect(challengeOf(locked.id).status).toBe('locked');
    await http.post(`/api/profile-verifications/${locked.id}/confirm`).set(bearer(tokens.manager))
      .send({ code: fake.lastCode() }).expect(400); // 잠긴 뒤엔 정답도 거부
  });

  it('재전송: cooldown 400 → 경과 후 새 코드·시도 카운터 리셋, 구 코드는 무효', async () => {
    const created = (await http.post('/api/profile-verifications').set(bearer(tokens.foreign))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'jung.new@tnacademy.test' }).expect(201)).body;
    const firstCode = fake.lastCode();
    await http.post(`/api/profile-verifications/${created.id}/resend`).set(bearer(tokens.foreign)).expect(400); // cooldown
    await force('profile_verification_challenges', created.id, { resendAvailableAt: new Date(Date.now() - 1000).toISOString() });
    const resent = (await http.post(`/api/profile-verifications/${created.id}/resend`).set(bearer(tokens.foreign)).expect(201)).body;
    expect(resent.status).toBe('pending');
    const secondCode = fake.lastCode();
    expect(secondCode).not.toBe(firstCode);
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.foreign))
      .send({ code: firstCode }).expect(400); // 구 코드 무효
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.foreign))
      .send({ code: secondCode }).expect(201);
  });

  it('만료: expires 경과 후 확인 → 400 + expired 전이(영속)', async () => {
    // manager의 기존 locked는 비활성 — 새 challenge 생성 가능
    const created = (await http.post('/api/profile-verifications').set(bearer(tokens.manager))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'manager.exp@tnacademy.test' }).expect(201)).body;
    // expires_at > created_at CHECK를 지키며 과거로 이동(생성 -20분·만료 -10분)
    await force('profile_verification_challenges', created.id, {
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.manager))
      .send({ code: fake.lastCode() }).expect(400);
    expect(challengeOf(created.id).status).toBe('expired');
  });

  it('이메일 변경 요청: verified challenge 소비 → 승인 → users 반영(원본)·응답/audit는 masked', async () => {
    const challengeId = await makeVerifiedEmailChallenge(tokens.instructor, 'park.final@tnacademy.test');
    // challenge 없이 연락처 변경 → 400
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', email: 'park.final@tnacademy.test', reason: '이메일 변경 요청(무인증).' }).expect(400);
    // 인증한 대상과 다른 값 → 400
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', email: 'other@tnacademy.test', verificationChallengeId: challengeId, reason: '다른 이메일로 제출.' }).expect(400);

    const created = (await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', email: 'Park.Final@tnacademy.test', verificationChallengeId: challengeId, reason: '이메일 소유 인증을 완료했습니다.' })
      .expect(201)).body;
    expect(created.status).toBe('pending');
    expect(created.verificationChallengeId).toBe(challengeId);
    expect(String(created.requestedChanges.email)).not.toBe('park.final@tnacademy.test'); // masked
    expect(challengeOf(challengeId)).toMatchObject({ status: 'consumed', consumedByRequestId: created.id });

    // 소비된 challenge 재사용 → 400 + 요청 미생성(rollback)
    const beforeCount = requestCount();
    await http.post('/api/profile-change-requests').set(bearer(tokens.foreign))
      .send({ currentPassword: 'demo1234', email: 'park.final2@tnacademy.test', verificationChallengeId: challengeId, reason: '남의 인증 재사용 시도.' }).expect(400);
    expect(requestCount()).toBe(beforeCount);

    // 승인 → users.email은 canonical 원본으로 반영, audit는 masked
    const approved = (await http.post(`/api/profile-change-requests/${created.id}/approve`).set(bearer(tokens.manager)).expect(201)).body;
    expect(approved.status).toBe('approved');
    expect(db.findById<UserRow & { id: number }>('users', 1)!.email).toBe('park.final@tnacademy.test');
    const audits = db.findAll<{ id: number; entity: string; entityId: number; action: string; changes?: Record<string, { after?: unknown }> }>('audit_log')
      .filter((row) => row.entity === 'users' && row.entityId === 1 && row.action === 'update');
    const emailAudit = audits[audits.length - 1]?.changes?.email;
    expect(emailAudit).toBeDefined();
    expect(String(emailAudit!.after)).not.toContain('park.final@tnacademy.test');
  });

  it('휴대전화(SMS) 변경: E.164 정규화 + provider check 소비 → 승인 반영', async () => {
    const created = (await http.post('/api/profile-verifications').set(bearer(tokens.foreign))
      .send({ currentPassword: 'demo1234', channel: 'sms', target: '010-7777-8888' }).expect(201)).body;
    expect(created.maskedTarget.startsWith('+82')).toBe(true); // E.164 정규화(마스킹 표시)
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.foreign))
      .send({ code: '111111' }).expect(400); // fake 오답
    await http.post(`/api/profile-verifications/${created.id}/confirm`).set(bearer(tokens.foreign))
      .send({ code: '424242' }).expect(201); // fake 정답
    const request2 = (await http.post('/api/profile-change-requests').set(bearer(tokens.foreign))
      .send({ currentPassword: 'demo1234', phone: '010-7777-8888', verificationChallengeId: created.id, reason: '휴대전화 소유 인증 완료.' })
      .expect(201)).body;
    await http.post(`/api/profile-change-requests/${request2.id}/approve`).set(bearer(tokens.manager)).expect(201);
    expect(db.findById<UserRow & { id: number }>('users', 2)!.phone).toBe('+821077778888');
  });

  it('email·phone 동시 변경은 400(채널당 인증 1건)', async () => {
    const challengeId = await makeVerifiedEmailChallenge(tokens.manager, 'manager.both@tnacademy.test');
    await http.post('/api/profile-change-requests').set(bearer(tokens.manager))
      .send({
        currentPassword: 'demo1234', email: 'manager.both@tnacademy.test', phone: '010-1234-0000',
        verificationChallengeId: challengeId, reason: '이메일과 전화 동시 변경 시도.',
      }).expect(400);
  });

  it('동시 소비 경쟁: 같은 verified challenge 두 요청 — 성공 1·나머지 거부, 요청·소비 정확 1건', async () => {
    // manager의 verified challenge(위 테스트에서 생성·미소비 상태 유지)
    const challenge = db.findBy<ChallengeRow & { id: number }>('profile_verification_challenges',
      (c) => c.status === 'verified' && c.targetNormalized === 'manager.both@tnacademy.test')[0];
    expect(challenge).toBeDefined();
    const body = {
      currentPassword: 'demo1234', email: 'manager.both@tnacademy.test',
      verificationChallengeId: challenge.id, reason: '동시 소비 경쟁 검증 요청.',
    };
    const before = requestCount();
    const [a, b] = await Promise.all([
      http.post('/api/profile-change-requests').set(bearer(tokens.manager)).send(body),
      http.post('/api/profile-change-requests').set(bearer(tokens.manager)).send(body),
    ]);
    expect([a.status, b.status].filter((code) => code === 201)).toHaveLength(1);
    expect(requestCount()).toBe(before + 1);
    expect(challengeOf(challenge.id).status).toBe('consumed');
  });

  it('provider 실패 주입: challenge row +0 · audit 실패 주입: 요청·소비 전부 rollback', async () => {
    const challengesBefore = db.findAll<{ id: number }>('profile_verification_challenges').length;
    fake.failNextSend = true;
    await http.post('/api/profile-verifications').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', channel: 'email', target: 'rollback@tnacademy.test' }).expect(500);
    expect(db.findAll<{ id: number }>('profile_verification_challenges').length).toBe(challengesBefore);

    const challengeId = await makeVerifiedEmailChallenge(tokens.instructor, 'rollback2@tnacademy.test');
    const requestsBefore = requestCount();
    const audit = app.get(AuditService);
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected audit failure'));
    await http.post('/api/profile-change-requests').set(bearer(tokens.instructor))
      .send({ currentPassword: 'demo1234', email: 'rollback2@tnacademy.test', verificationChallengeId: challengeId, reason: '감사 실패 롤백 검증.' })
      .expect(500);
    spy.mockRestore();
    expect(requestCount()).toBe(requestsBefore); // 요청 +0
    expect(challengeOf(challengeId).status).toBe('verified'); // 소비도 롤백
  });
});
