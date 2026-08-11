import { BadRequestException } from '@nestjs/common';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

export type ContactChannel = 'email' | 'sms';

/** 연락처 정규화 단일 소스: email=lowercase, sms=E.164(KR 기본 국가). */
export function normalizeContactTarget(channel: ContactChannel, raw: string): string {
  if (channel === 'email') {
    const email = raw.trim().toLowerCase();
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new BadRequestException('올바른 이메일 주소가 아닙니다.');
    }
    return email;
  }

  const parsed = parsePhoneNumberFromString(raw.trim(), 'KR');
  if (!parsed?.isValid() || !/^\+[1-9]\d{7,14}$/.test(parsed.number)) {
    throw new BadRequestException('올바른 휴대전화 번호가 아닙니다.');
  }
  return parsed.number;
}

/** 레거시 users.phone 비교용. 잘못된 기존 값은 중복 판정에서 제외하고 원문을 노출하지 않는다. */
export function tryNormalizePhone(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    return normalizeContactTarget('sms', raw);
  } catch {
    return null;
  }
}
