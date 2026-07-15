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

const TWILIO_BASE = 'https://verify.twilio.com/v2';
const SENS_BASE = 'https://sens.apigw.ntruss.com';

type SensConfig = { accessKey: string; secretKey: string; serviceId: string; from: string };

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
    const res = await fetch(`${TWILIO_BASE}/Services/${serviceSid}/VerificationCheck`, {
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
    const path = `/sms/v2/services/${encodeURIComponent(sens.serviceId)}/messages`;
    const timestamp = String(Date.now());
    const { countryCode, to } = sensRecipientOf(input.target);
    const res = await fetch(`${SENS_BASE}${path}`, {
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
      // 응답 본문에 대상 번호가 섞일 수 있어 상태 코드만 로깅(§7 redaction — 코드/번호 로그 금지).
      this.logger.warn(`SENS 발송 실패: HTTP ${res.status}`);
      throw new ServiceUnavailableException('인증 문자 발송에 실패했습니다.');
    }
    const body = (await res.json().catch(() => ({}))) as { requestId?: string };
    return { provider: 'ncp_sens', providerReference: body.requestId ?? null };
  }

  private sensConfig(): SensConfig | null {
    const accessKey = process.env.NCP_SENS_ACCESS_KEY;
    const secretKey = process.env.NCP_SENS_SECRET_KEY;
    const serviceId = process.env.NCP_SENS_SERVICE_ID;
    const from = process.env.NCP_SENS_FROM;
    if (!accessKey && !secretKey && !serviceId && !from) return null; // 미설정 → Twilio fallback
    if (!accessKey || !secretKey || !serviceId || !from) {
      // 부분 설정은 구성 오류 — 조용한 fallback 대신 fail-closed(잘못된 채널로 새는 것 방지).
      throw new ServiceUnavailableException('SENS 설정이 불완전합니다(NCP_SENS_ACCESS_KEY/SECRET_KEY/SERVICE_ID/FROM 4종 필요).');
    }
    return { accessKey, secretKey, serviceId, from };
  }

  // ── Twilio Verify (legacy fallback) ──────────────────────────────────────
  private async sendViaTwilio(input: SendChallengeInput): Promise<ProviderChallenge> {
    const { sid, auth, serviceSid } = this.twilioConfig();
    const res = await fetch(`${TWILIO_BASE}/Services/${serviceSid}/Verifications`, {
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
