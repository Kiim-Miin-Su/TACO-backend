// [2026-07-15 SENS 전환] NCP SENS SMS 인증 e2e — 실 발송 0(fetch를 SENS 호스트에서 가로채 202 응답).
//  검증 대상: ① 요청 형식(공식 raw serviceId 경로·HMAC 서명·본문) ② 코드 소유권 전환(서비스 생성 OTP → salted
//  hash 저장 → confirm은 provider check가 아닌 hash 대조) ③ 부분 설정 fail-closed.
//  env는 이 파일에서만 주입하고 afterAll에서 원복(같은 워커의 다음 스위트 오염 방지 — hermetic 규약).
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import {
  DefaultContactVerificationProvider,
  sensFailureDiagnostic,
  sensRecipientOf,
  sensSignature,
} from '../src/modules/profile-verifications/default-contact-verification.provider';
import type { MailService } from '../src/modules/mail/mail.service';

const SENS_ENV = {
  NCP_SENS_ACCESS_KEY_ID: ' test-access-key ',
  NCP_SENS_SECRET_KEY: ' test-secret-key\n',
  NCP_SENS_SERVICE_ID: ' ncp:sms:kr:123:taco ', // 실제 SENS 형식 — ':'를 URL 인코딩하지 않는다.
  NCP_SENS_FROM: '02-1234-5678',
} as const;
const SENS_PATH = '/sms/v2/services/ncp:sms:kr:123:taco/messages';

type CapturedCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

describe('[SENS] contact verification via NCP SENS (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const calls: CapturedCall[] = [];
  const originalFetch = global.fetch;

  beforeAll(async () => {
    Object.assign(process.env, SENS_ENV);
    global.fetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      const u = String(url);
      if (!u.startsWith('https://sens.apigw.ntruss.com')) return originalFetch(url as string, init as never);
      calls.push({ url: u, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') });
      return { status: 202, ok: true, json: async () => ({ requestId: `sens-req-${calls.length}` }) } as Response;
    }) as typeof fetch;
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    for (const k of Object.keys(SENS_ENV)) delete process.env[k];
    await app.close();
  });

  const login = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken as string;
  const lastSmsCode = (): string => {
    const content = String(calls[calls.length - 1]?.body.content ?? '');
    return content.match(/\d{6}/)?.[0] ?? '';
  };

  it('발송 — SENS 요청 형식: raw 경로·HMAC 서명·설정 정규화·국내번호 변환·코드 포함, 행은 ncp_sens+codeHash', async () => {
    const token = await login('park_inst');
    const created = await http
      .post('/api/profile-verifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'sms', target: '010-5555-0101', currentPassword: 'demo1234' })
      .expect(201);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    // 경로: 공식 SENS 예시와 동일하게 serviceId의 ':'를 그대로 사용한다.
    expect(call.url).toBe(`https://sens.apigw.ntruss.com${SENS_PATH}`);
    // 서명: 캡처된 timestamp로 재계산 시 정확히 일치(HMAC-SHA256 base64 — 대상 문자열 규약 고정).
    const ts = call.headers['x-ncp-apigw-timestamp'];
    expect(ts).toMatch(/^\d{13}$/);
    expect(call.headers['x-ncp-iam-access-key']).toBe('test-access-key');
    expect(call.headers['x-ncp-apigw-signature-v2']).toBe(
      sensSignature('test-secret-key', 'POST', SENS_PATH, ts, 'test-access-key'),
    );
    // 본문: E.164(+8210...) → 국내 표기(010...), 발신번호=사전등록 번호, 6자리 코드 포함.
    expect(call.body).toMatchObject({ type: 'SMS', countryCode: '82', from: '0212345678' });
    expect(call.body.messages).toEqual([{ to: '01055550101' }]);
    expect(lastSmsCode()).toMatch(/^\d{6}$/);
    // 행: provider=ncp_sens, 코드 소유권=서비스(codeHash 저장·평문 미저장), reference=SENS requestId.
    const row = db
      .findAll<{ id: number; provider: string; codeHash?: string | null; providerReference?: string | null }>('profile_verification_challenges')
      .find((r) => r.id === created.body.id)!;
    expect(row.provider).toBe('ncp_sens');
    expect(row.codeHash).toBeTruthy();
    expect(row.codeHash).not.toBe(lastSmsCode());
    expect(row.providerReference).toBe('sens-req-1');
  });

  it('확인 — hash 대조(오답 400·attempt+1, 정답 verified). provider check 미호출(SENS 추가 fetch 0)', async () => {
    const token = await login('park_inst');
    const created = await http
      .post('/api/profile-verifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ channel: 'sms', target: '010-5555-0102', currentPassword: 'demo1234' })
      .expect(201);
    const id = created.body.id as number;
    const code = lastSmsCode();
    const sendCount = calls.length;

    await http.post(`/api/profile-verifications/${id}/confirm`).set('Authorization', `Bearer ${token}`).send({ code: '000000' }).expect(400);
    const afterWrong = db.findAll<{ id: number; attemptCount: number }>('profile_verification_challenges').find((r) => r.id === id)!;
    expect(afterWrong.attemptCount).toBe(1);

    const ok = await http.post(`/api/profile-verifications/${id}/confirm`).set('Authorization', `Bearer ${token}`).send({ code }).expect(201);
    expect(ok.body.status).toBe('verified');
    expect(calls.length).toBe(sendCount); // 확인은 로컬 hash 대조 — SENS/Twilio 왕복 없음
  });

  it('fail-closed — 부분 설정은 503(조용한 Twilio fallback 금지), 설정 유무로 코드 소유권 전환', () => {
    const provider = new DefaultContactVerificationProvider({} as MailService);
    expect(provider.ownsCode('sms')).toBe(false); // SENS 4종 설정 → 서비스 소유
    const secret = process.env.NCP_SENS_SECRET_KEY;
    delete process.env.NCP_SENS_SECRET_KEY;
    try {
      expect(() => provider.ownsCode('sms')).toThrow(ServiceUnavailableException); // 부분 설정=구성 오류
    } finally {
      process.env.NCP_SENS_SECRET_KEY = secret;
    }
  });

  it('단위 규약 — 서명 고정 벡터·수신번호 변환(+82=0 접두, 그 외=국가번호 분리)', () => {
    // 고정 벡터: 구현 변경(대상 문자열/인코딩/해시)이 있으면 즉시 깨진다.
    expect(sensSignature('test-secret-key', 'POST', SENS_PATH, '1752555555555', 'test-access-key')).toBe(
      'nIEdj8jDcbr68OD5xkD7HQgcS3nVLl2bzO5pX4pQgaU=',
    );
    expect(sensRecipientOf('+821055550101')).toEqual({ countryCode: '82', to: '01055550101' });
    expect(sensRecipientOf('+447911123456')).toEqual({ countryCode: '44', to: '7911123456' });
    expect(sensFailureDiagnostic({ error: { errorCode: '200', message: 'Authentication Failed' } }))
      .toEqual({ providerCode: '200', category: 'authentication' });
    expect(sensFailureDiagnostic({ errorCode: '<unsafe>', message: 'contains signature mismatch' }))
      .toEqual({ providerCode: 'unknown', category: 'signature' });
  });
});
