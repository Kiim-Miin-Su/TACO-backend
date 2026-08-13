import type { VerificationPurpose } from '@kms545487/contracts';

export type VerificationEmailCopy = {
  subject: string;
  heading: string;
  instruction: string;
};

const COPY_BY_PURPOSE: Record<VerificationPurpose, VerificationEmailCopy> = {
  signup: {
    subject: '[TACO ERP] 회원가입 인증 코드',
    heading: '회원가입 인증 코드',
    instruction: '회원가입을 계속하려면 10분 안에 인증 코드를 입력해 주세요.',
  },
  account_recovery: {
    subject: '[TACO ERP] 계정 찾기 인증 코드',
    heading: '계정 찾기 인증 코드',
    instruction: '아이디 찾기 또는 비밀번호 재설정을 계속하려면 10분 안에 인증 코드를 입력해 주세요.',
  },
  profile_change: {
    subject: '[TACO ERP] 내 정보 변경 인증 코드',
    heading: '내 정보 변경 인증 코드',
    instruction: '내 정보 변경을 계속하려면 10분 안에 인증 코드를 입력해 주세요.',
  },
  password_change: {
    subject: '[TACO ERP] 비밀번호 변경 인증 코드',
    heading: '비밀번호 변경 인증 코드',
    instruction: '비밀번호 변경을 계속하려면 10분 안에 인증 코드를 입력해 주세요.',
  },
  account_setup: {
    subject: '[TACO ERP] 계정 정보 설정 인증 코드',
    heading: '계정 정보 설정 인증 코드',
    instruction: '첫 로그인 계정 정보 설정을 계속하려면 10분 안에 인증 코드를 입력해 주세요.',
  },
};

export const verificationEmailCopyOf = (purpose: VerificationPurpose): VerificationEmailCopy =>
  COPY_BY_PURPOSE[purpose];
