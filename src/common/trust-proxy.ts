import type { INestApplication } from '@nestjs/common';

export type TrustProxySetting = false | number | string[];

export function trustProxySetting(): TrustProxySetting {
  const raw = (process.env.TRUST_PROXY ?? '').trim();
  if (!raw) return false;
  if (raw === 'true' || raw === '*') {
    throw new Error('[proxy] TRUST_PROXY=true/* 는 client IP 위조를 허용하므로 사용할 수 없습니다. hop 수 또는 CIDR을 지정하세요.');
  }
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (!Number.isSafeInteger(hops) || hops < 1) throw new Error('[proxy] TRUST_PROXY hop 수는 1 이상의 정수여야 합니다.');
    return hops;
  }
  const cidrs = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (!cidrs.length) return false;
  return cidrs;
}

export function configureTrustProxy(app: INestApplication): void {
  app.getHttpAdapter().getInstance().set('trust proxy', trustProxySetting());
}
