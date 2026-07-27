import { isProduction } from './env';

const LOCAL_WEB_ORIGIN = 'http://localhost:3000';

export function webAppOrigin(): string {
  const raw = process.env.WEB_ORIGIN?.trim() || (isProduction() ? '' : LOCAL_WEB_ORIGIN);
  if (!raw) throw new Error('WEB_ORIGIN이 필요합니다.');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('WEB_ORIGIN은 유효한 절대 URL이어야 합니다.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('WEB_ORIGIN은 http(s)만 허용합니다.');
  if (isProduction() && parsed.protocol !== 'https:') throw new Error('운영 WEB_ORIGIN은 https여야 합니다.');
  if (parsed.username || parsed.password) throw new Error('WEB_ORIGIN에 사용자 정보를 포함할 수 없습니다.');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('WEB_ORIGIN은 path/query/hash 없는 origin만 허용합니다.');
  }
  return parsed.origin;
}

export function buildWebAppUrl(pathname: string, params: Record<string, string> = {}): string {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) throw new Error('내부 웹 경로는 /로 시작해야 합니다.');
  const url = new URL(pathname, `${webAppOrigin()}/`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function assertWebAppLink(value: string): string {
  const parsed = new URL(value);
  if (parsed.origin !== webAppOrigin()) throw new Error('메일 링크 origin이 WEB_ORIGIN과 다릅니다.');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('메일 링크는 http(s)만 허용합니다.');
  return parsed.toString();
}
