import type { Request, Response } from 'express';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';

export function readCookie(req: Pick<Request, 'headers'>, name: string): string | undefined {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

const productionCookie = (): boolean => process.env.NODE_ENV === 'production';

/**
 * Access JWT는 브라우저 JavaScript에 절대 노출하지 않는다. production 브라우저는 Next `/api`
 * same-origin rewrite를 통하므로 SameSite=Lax를 유지할 수 있다. Path=/는 Next middleware가
 * cookie 존재만 낙관적으로 확인하기 위해 필요하며 실제 인증/인가는 backend가 수행한다.
 */
export function setAccessCookie(res: Response, raw: string, expiresAtMs: number): void {
  res.cookie(ACCESS_COOKIE, raw, {
    httpOnly: true,
    secure: productionCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(0, expiresAtMs - Date.now()),
  });
}

export function clearAccessCookie(res: Response): void {
  res.cookie(ACCESS_COOKIE, '', {
    httpOnly: true,
    secure: productionCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}

export function setRefreshCookie(res: Response, raw: string, expiresAtIso: string): void {
  res.cookie(REFRESH_COOKIE, raw, {
    httpOnly: true,
    secure: productionCookie(),
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: Math.max(0, Date.parse(expiresAtIso) - Date.now()),
  });
}

export function clearRefreshCookie(res: Response): void {
  res.cookie(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure: productionCookie(),
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: 0,
  });
}

export function clearBrowserSession(res: Response): void {
  clearAccessCookie(res);
  clearRefreshCookie(res);
}
