import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
  async sendVerifyEmail(to: string, link: string): Promise<{ sent: boolean; devLink?: string }> {
    if (!this.transporter) {
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

  // [테스트 안정화 2026-07-03] SMTP 설정 시 nodemailer 트랜스포터가 열린 소켓/풀을 남겨
  //  app.close() 후에도 jest worker가 정상 종료 못 하던 문제 → 종료 시 명시적으로 닫는다.
  onModuleDestroy(): void {
    this.transporter?.close();
  }
}
