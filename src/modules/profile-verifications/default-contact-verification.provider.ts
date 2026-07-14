// [TBO-29B-4 §4] 기본 provider 구현 — email=SMTP OTP 발송, sms=Twilio Verify REST.
//  fail-closed: 채널 설정 누락 시 발송을 거부한다(자동 성공 금지). production 여부와 무관하게 동일 —
//  개발 편의 폴백은 인증 우회 경로가 되므로 만들지 않는다(테스트는 DI fake로 대체).
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import type {
  CheckChallengeInput,
  ContactVerificationProvider,
  ProviderChallenge,
  ProviderCheckResult,
  SendChallengeInput,
} from './contact-verification.provider';

const TWILIO_BASE = 'https://verify.twilio.com/v2';

@Injectable()
export class DefaultContactVerificationProvider implements ContactVerificationProvider {
  private readonly logger = new Logger(DefaultContactVerificationProvider.name);

  constructor(private readonly mail: MailService) {}

  async send(input: SendChallengeInput): Promise<ProviderChallenge> {
    if (input.channel === 'email') {
      if (!input.code) throw new Error('email 채널은 서비스가 생성한 code가 필요합니다.');
      const sent = await this.mail.sendOtpEmail(input.target, input.code);
      if (!sent) throw new ServiceUnavailableException('인증 메일 발송이 설정되지 않았습니다.');
      return { provider: 'email_smtp', providerReference: null };
    }
    // sms — Twilio Verify: 코드 생성/보관/검증을 Twilio가 소유.
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
      // 응답 본문에 대상 번호가 섞일 수 있어 상태 코드만 로깅(§7 redaction).
      this.logger.warn(`Twilio Verify 발송 실패: HTTP ${res.status}`);
      throw new ServiceUnavailableException('인증 문자 발송에 실패했습니다.');
    }
    const body = (await res.json()) as { sid?: string };
    return { provider: 'twilio_verify', providerReference: body.sid ?? null };
  }

  async check(input: CheckChallengeInput): Promise<ProviderCheckResult> {
    if (input.channel === 'email') {
      // email은 서비스가 hash 대조 — provider check 경로를 타지 않는다.
      throw new Error('email 채널 확인은 서비스 hash 대조를 사용합니다.');
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
