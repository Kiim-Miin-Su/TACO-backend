import type { VerificationPurpose } from '@kms545487/contracts';
import { MailService } from '../src/modules/mail/mail.service';

type SentMail = { subject?: string; text?: string; html?: string };

describe('Verification email copy by purpose (TBO-97)', () => {
  const cases: Array<[VerificationPurpose, string, string]> = [
    ['signup', '[TACO ERP] 회원가입 인증 코드', '회원가입을 계속하려면'],
    ['account_recovery', '[TACO ERP] 계정 찾기 인증 코드', '아이디 찾기 또는 비밀번호 재설정을 계속하려면'],
    ['profile_change', '[TACO ERP] 내 정보 변경 인증 코드', '내 정보 변경을 계속하려면'],
    ['password_change', '[TACO ERP] 비밀번호 변경 인증 코드', '비밀번호 변경을 계속하려면'],
    ['account_setup', '[TACO ERP] 계정 정보 설정 인증 코드', '첫 로그인 계정 정보 설정을 계속하려면'],
  ];

  it.each(cases)('%s 목적은 제목·본문을 고유하게 발송한다', async (purpose, subject, instruction) => {
    const sent: SentMail[] = [];
    const service = new MailService();
    const writable = service as unknown as {
      transporter: { sendMail: (mail: SentMail) => Promise<void>; close: () => void };
    };
    writable.transporter = {
      sendMail: async (mail) => { sent.push(mail); },
      close: () => undefined,
    };

    await expect(service.sendOtpEmail('masked@example.test', '123456', purpose)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe(subject);
    expect(sent[0]?.text).toContain(instruction);
    expect(sent[0]?.text).toContain('123456');
    expect(sent[0]?.html).toContain(instruction);
    expect(sent[0]?.html).toContain('123456');
  });
});
