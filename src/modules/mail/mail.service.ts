import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { isProduction } from '../../common/env'; // [TBO-34 C3] 환경 판정 단일 진실원
import * as nodemailer from 'nodemailer';

/**
 * 이메일 발송. 운영에서는 SMTP 환경변수로 무료 SMTP(예: Gmail 앱비밀번호, Resend, Brevo 무료티어)를 연결.
 * SMTP 미설정(데모/로컬)에서는 실제 발송 대신 콘솔에 링크를 남기고 devLink를 반환 → 개발 중 인증 흐름 확인.
 *
 * 필요한 환경변수: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
 */
@Injectable()
export class MailService implements OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly enabled = !!process.env.SMTP_HOST;
  private transporter = this.enabled
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      })
    : null;

  // 인증 메일 발송. 반환된 devLink는 SMTP 미설정 시에만 존재(데모 편의).
  //  [TBO-28B §4-c] production에서는 devLink 폴백 금지(응답·로그 어디에도 인증 URL 미노출) —
  //  SMTP 미설정 production은 부팅 자체가 차단되지만(assertProductionBootSafety) 이중 방어로 여기서도 막는다.
  async sendVerifyEmail(to: string, link: string): Promise<{ sent: boolean; devLink?: string }> {
    if (!this.transporter) {
      if (isProduction()) {
        throw new Error('[mail] production에서 SMTP 미설정 — 인증 메일을 보낼 수 없습니다(devLink 폴백 금지).');
      }
      this.logger.warn(`[MAIL:dev] 이메일 인증 링크 (${to}): ${link}`);
      return { sent: false, devLink: link };
    }
    await this.transporter.sendMail({
      from: process.env.MAIL_FROM ?? 'no-reply@tnacademy.test',
      to,
      subject: '[TACO ERP] 이메일 인증을 완료해 주세요',
      text: `아래 링크를 눌러 이메일 인증을 완료하세요:\n${link}`,
      html: `<p>아래 버튼을 눌러 이메일 인증을 완료하세요.</p><p><a href="${link}">이메일 인증하기</a></p><p>${link}</p>`,
    });
    return { sent: true };
  }

  // [TBO-29B-4] 연락처 재인증 OTP 발송 — 평문 코드는 발송 직후 폐기(저장은 서비스가 salted hash만).
  // [TBO-29C C5] 아이디 찾기 — 가입 이메일로 아이디 안내. dev(무SMTP·비production)는 콘솔+devWebId 반환.
  async sendRecoverIdEmail(to: string, webId: string): Promise<{ sent: boolean; devWebId?: string }> {
    if (!this.transporter) {
      if (isProduction()) {
        throw new Error('[mail] production에서 SMTP 미설정 — 아이디 안내 메일을 보낼 수 없습니다.');
      }
      this.logger.warn(`[MAIL:dev] 아이디 안내 (${to}): webId=${webId}`);
      return { sent: false, devWebId: webId };
    }
    await this.transporter.sendMail({
      from: process.env.MAIL_FROM ?? 'no-reply@tnacademy.test',
      to,
      subject: '[TACO ERP] 아이디 안내',
      text: `요청하신 아이디는 다음과 같습니다: ${webId}
본인이 요청하지 않았다면 이 메일을 무시하세요.`,
      html: `<p>요청하신 아이디</p><p style="font-size:20px;font-weight:bold">${webId}</p><p>본인이 요청하지 않았다면 이 메일을 무시하세요.</p>`,
    });
    return { sent: true };
  }

  // [TBO-29C C5] 비밀번호 재설정 링크 — 토큰은 sha256만 저장·1시간 만료. dev는 콘솔+devLink 반환.
  async sendPasswordResetEmail(to: string, link: string): Promise<{ sent: boolean; devLink?: string }> {
    if (!this.transporter) {
      if (isProduction()) {
        throw new Error('[mail] production에서 SMTP 미설정 — 재설정 메일을 보낼 수 없습니다.');
      }
      this.logger.warn(`[MAIL:dev] 비밀번호 재설정 링크 (${to}): ${link}`);
      return { sent: false, devLink: link };
    }
    await this.transporter.sendMail({
      from: process.env.MAIL_FROM ?? 'no-reply@tnacademy.test',
      to,
      subject: '[TACO ERP] 비밀번호 재설정',
      text: `아래 링크에서 1시간 안에 비밀번호를 재설정하세요:
${link}
본인이 요청하지 않았다면 이 메일을 무시하세요.`,
      html: `<p>아래 버튼을 눌러 1시간 안에 비밀번호를 재설정하세요.</p><p><a href="${link}">비밀번호 재설정</a></p><p>${link}</p><p>본인이 요청하지 않았다면 이 메일을 무시하세요.</p>`,
    });
    return { sent: true };
  }

  //  fail-closed: SMTP 미설정이면 false 반환(호출부가 채널 차단) — devLink류 폴백을 만들지 않는다(§4).
  async sendOtpEmail(to: string, code: string): Promise<boolean> {
    if (!this.transporter) return false;
    await this.transporter.sendMail({
      from: process.env.MAIL_FROM ?? 'no-reply@tnacademy.test',
      to,
      subject: '[TACO ERP] 연락처 변경 인증 코드',
      text: `연락처 변경 인증 코드: ${code}\n10분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시하세요.`,
      html: `<p>연락처 변경 인증 코드</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>10분 안에 입력해 주세요. 본인이 요청하지 않았다면 이 메일을 무시하세요.</p>`,
    });
    return true;
  }

  // [테스트 안정화 2026-07-03] SMTP 설정 시 nodemailer 트랜스포터가 열린 소켓/풀을 남겨
  //  app.close() 후에도 jest worker가 정상 종료 못 하던 문제 → 종료 시 명시적으로 닫는다.
  onModuleDestroy(): void {
    this.transporter?.close();
  }
}
