// [TBO-29B-4 §4] 기본 provider 구현 — email=SMTP OTP 발송, sms=NCP SENS(기본)/Twilio Verify(legacy).
//  fail-closed: 채널 설정 누락 시 발송을 거부한다(자동 성공 금지). production 여부와 무관하게 동일 —
//  개발 편의 폴백은 인증 우회 경로가 되므로 만들지 않는다(테스트는 DI fake로 대체).
//
//  [2026-07-15 SENS 전환] 네이버 클라우드 SENS는 단순 발송 API(Verify류 없음) → 코드 소유권이
//  서비스에 있다(ownsCode('sms')=false → 서비스가 OTP 생성·salted hash 저장·hash 대조).
//  SENS 설정(NCP_SENS_* 4종)이 있으면 SENS, 없고 TWILIO_*가 있으면 Twilio Verify, 둘 다 없으면 503.
import { createHmac } from 'node:crypto';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import parsePhoneNumberFromString from 'libphonenumber-js';
import { MailService } from '../mail/mail.service';
import type { VerificationChannel } from './profile-verification.entity';
import type {
  CheckChallengeInput,
  ContactVerificationProvider,
  ProviderChallenge,
  ProviderCheckResult,
  SendChallengeInput,
} from './contact-verification.provider';
import { fetchTrustedOrigin } from '../../common/trusted-fetch';
import { ncpSensAccessKey } from './sms-availability';

const TWILIO_BASE = 'https://verify.twilio.com/v2';
const SENS_BASE = 'https://sens.apigw.ntruss.com';

type SensConfig = { accessKey: string; secretKey: string; serviceId: string; from: string };

type SensErrorBody = { error?: { errorCode?: unknown; message?: unknown }; errorCode?: unknown; message?: unknown };

/** SENS 오류 원문에는 요청 정보가 섞일 수 있으므로 로그에는 안전한 분류와 짧은 코드만 남긴다. */
export function sensFailureDiagnostic(body: SensErrorBody): { providerCode: string; category: string } {
  const rawCode = body.error?.errorCode ?? body.errorCode;
  const providerCode = typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(rawCode)
    ? rawCode
    : 'unknown';
  const rawMessage = body.error?.message ?? body.message;
  const message = typeof rawMessage === 'string' ? rawMessage.toLowerCase() : '';
  const category = /signature/.test(message)
    ? 'signature'
    : /access|permission|service.?id/.test(message)
      ? 'authorization'
      : /auth|unauthor/.test(message)
        ? 'authentication'
        : 'provider_rejected';
  return { providerCode, category };
}

/** SENS API 게이트웨이 서명 — base64(HMAC-SHA256(secret, "POST {path}\n{timestamp}\n{accessKey}")). */
export function sensSignature(secretKey: string, method: string, path: string, timestamp: string, accessKey: string): string {
  return createHmac('sha256', secretKey).update(`${method} ${path}\n${timestamp}\n${accessKey}`).digest('base64');
}

/** E.164 → SENS 수신 형식. +82는 국내 표기(0 접두), 그 외는 국가번호 분리(콘솔에서 국제 SMS 활성화 필요). */
export function sensRecipientOf(e164: string): { countryCode: string; to: string } {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) throw new ServiceUnavailableException('수신 번호 형식을 해석할 수 없습니다.');
  const cc = parsed.countryCallingCode;
  const national = parsed.nationalNumber;
  return cc === '82' ? { countryCode: '82', to: `0${national}` } : { countryCode: cc, to: national };
}

@Injectable()
export class DefaultContactVerificationProvider implements ContactVerificationProvider {
  private readonly logger = new Logger(DefaultContactVerificationProvider.name);

  constructor(private readonly mail: MailService) {}

  // 코드 소유권 — email·SENS=서비스(hash 대조), Twilio Verify=provider(check 위임).
  ownsCode(channel: VerificationChannel): boolean {
    if (channel === 'email') return false;
    return this.sensConfig() === null; // SENS 설정 시 서비스 소유(false), 미설정 시 Twilio Verify 소유(true)
  }

  async send(input: SendChallengeInput): Promise<ProviderChallenge> {
    if (input.channel === 'email') {
      if (!input.code) throw new Error('email 채널은 서비스가 생성한 code가 필요합니다.');
      const sent = await this.mail.sendOtpEmail(input.target, input.code);
      if (!sent) throw new ServiceUnavailableException('인증 메일 발송이 설정되지 않았습니다.');
      return { provider: 'email_smtp', providerReference: null };
    }
    const sens = this.sensConfig();
    if (sens) return this.sendViaSens(sens, input);
    return this.sendViaTwilio(input);
  }

  async check(input: CheckChallengeInput): Promise<ProviderCheckResult> {
    if (input.channel === 'email') {
      // email은 서비스가 hash 대조 — provider check 경로를 타지 않는다.
      throw new Error('email 채널 확인은 서비스 hash 대조를 사용합니다.');
    }
    if (this.sensConfig()) {
      // SENS 발송분(codeHash 저장)은 서비스가 hash 대조 — 여기 도달하면 호출부 버그.
      throw new Error('SENS 채널 확인은 서비스 hash 대조를 사용합니다.');
    }
    const { sid, auth, serviceSid } = this.twilioConfig();
    const res = await fetchTrustedOrigin(`${TWILIO_BASE}/Services/${serviceSid}/VerificationCheck`, TWILIO_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: input.target, Code: input.code }),
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { status?: string };
    return { ok: body.status === 'approved' };
  }

  // ── NCP SENS ──────────────────────────────────────────────────────────────
  private async sendViaSens(sens: SensConfig, input: SendChallengeInput): Promise<ProviderChallenge> {
    if (!input.code) throw new Error('SENS 채널은 서비스가 생성한 code가 필요합니다.');
    // NCP 서명은 실제 요청 URI와 바이트 단위로 같아야 한다. SENS serviceId의 ':'는
    // 공식 요청 예시처럼 그대로 둔다(%3A로 인코딩하면 API Gateway가 서명을 401로 거절할 수 있다).
    const path = `/sms/v2/services/${sens.serviceId}/messages`;
    const timestamp = String(Date.now());
    const { countryCode, to } = sensRecipientOf(input.target);
    const res = await fetchTrustedOrigin(`${SENS_BASE}${path}`, SENS_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-ncp-apigw-timestamp': timestamp,
        'x-ncp-iam-access-key': sens.accessKey,
        'x-ncp-apigw-signature-v2': sensSignature(sens.secretKey, 'POST', path, timestamp, sens.accessKey),
      },
      body: JSON.stringify({
        type: 'SMS',
        contentType: 'COMM',
        countryCode,
        from: sens.from,
        content: `[TACO ERP] 인증번호 ${input.code}`,
        messages: [{ to }],
      }),
    });
    if (res.status !== 202) {
      const errorBody = (await res.json().catch(() => ({}))) as SensErrorBody;
      const diagnostic = sensFailureDiagnostic(errorBody);
      // 응답 원문은 번호·Service ID를 포함할 수 있어 기록하지 않는다. 분류와 provider code만 남긴다.
      this.logger.warn(`SENS 발송 실패: HTTP ${res.status} code=${diagnostic.providerCode} category=${diagnostic.category}`);
      throw new ServiceUnavailableException('인증 문자 발송에 실패했습니다.');
    }
    const body = (await res.json().catch(() => ({}))) as { requestId?: string };
    return { provider: 'ncp_sens', providerReference: body.requestId ?? null };
  }

  private sensConfig(): SensConfig | null {
    // Vercel 대시보드에서 복사한 값에 붙는 앞뒤 공백/개행은 인증 서명을 깨뜨리므로 제거한다.
    const accessKey = ncpSensAccessKey();
    const secretKey = process.env.NCP_SENS_SECRET_KEY?.trim();
    const serviceId = process.env.NCP_SENS_SERVICE_ID?.trim();
    // SENS 발신번호는 숫자만 허용한다. 콘솔 표기(02-1234-5678)를 그대로 붙여도 동작하게 한다.
    const rawFrom = process.env.NCP_SENS_FROM?.trim();
    const from = rawFrom?.replace(/[\s-]/g, '');
    if (!accessKey && !secretKey && !serviceId && !from) return null; // 미설정 → Twilio fallback
    if (!accessKey || !secretKey || !serviceId || !from) {
      // 부분 설정은 구성 오류 — 조용한 fallback 대신 fail-closed(잘못된 채널로 새는 것 방지).
      throw new ServiceUnavailableException('SENS 설정이 불완전합니다(NCP_SENS_ACCESS_KEY_ID/SECRET_KEY/SERVICE_ID/FROM 4종 필요).');
    }
    if (!/^ncp:sms:[a-z]{2}:[^/]+:[^/]+$/.test(serviceId)) {
      throw new ServiceUnavailableException('SENS Service ID 형식이 올바르지 않습니다.');
    }
    if (!/^\d+$/.test(from)) {
      throw new ServiceUnavailableException('SENS 발신번호는 숫자만 입력해야 합니다.');
    }
    return { accessKey, secretKey, serviceId, from };
  }

  // ── Twilio Verify (legacy fallback) ──────────────────────────────────────
  private async sendViaTwilio(input: SendChallengeInput): Promise<ProviderChallenge> {
    const { sid, auth, serviceSid } = this.twilioConfig();
    const res = await fetchTrustedOrigin(`${TWILIO_BASE}/Services/${serviceSid}/Verifications`, TWILIO_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: input.target, Channel: 'sms' }),
    });
    if (!res.ok) {
      this.logger.warn(`Twilio Verify 발송 실패: HTTP ${res.status}`);
      throw new ServiceUnavailableException('인증 문자 발송에 실패했습니다.');
    }
    const body = (await res.json()) as { sid?: string };
    return { provider: 'twilio_verify', providerReference: body.sid ?? null };
  }

  private twilioConfig(): { sid: string; auth: string; serviceSid: string } {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!sid || !auth || !serviceSid) {
      // fail-closed — 설정 없으면 채널 자체를 닫는다(§4).
      throw new ServiceUnavailableException('휴대전화 인증이 아직 설정되지 않았습니다.');
    }
    return { sid, auth, serviceSid };
  }
}
