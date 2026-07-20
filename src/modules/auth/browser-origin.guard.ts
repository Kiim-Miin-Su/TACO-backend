import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { trustedWebOrigins } from '../../common/cors-origin';
import { AuthEventsService } from './auth-events.service';
import { ACCESS_COOKIE, REFRESH_COOKIE, readCookie } from './browser-session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isLoginRequest(req: Request): boolean {
  const pathname = String(req.originalUrl || req.url || '').split('?', 1)[0].replace(/\/+$/, '');
  return pathname === '/auth/login' || pathname === '/api/auth/login';
}

function requestOrigin(req: Request): string | null {
  const origin = String(req.headers.origin ?? '').trim();
  if (origin) return origin;
  const referer = String(req.headers.referer ?? '').trim();
  if (!referer) return null;
  try { return new URL(referer).origin; } catch { return null; }
}

/**
 * HttpOnly cookie 인증의 상태 변경을 Origin allowlist로 방어한다.
 * Bearer는 브라우저 simple request가 만들 수 없는 명시적 인증 헤더라 이행 기간 호환을 유지한다.
 * non-production은 로컬 CLI/supertest 호환을 위해 강제하지 않고 production에서 fail-closed 한다.
 */
@Injectable()
export class BrowserOriginGuard implements CanActivate {
  constructor(private readonly events: AuthEventsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.NODE_ENV !== 'production') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
    if (/^Bearer\s+\S+/i.test(String(req.headers.authorization ?? ''))) return true;

    const hasSessionCookie = Boolean(readCookie(req, ACCESS_COOKIE) || readCookie(req, REFRESH_COOKIE));
    // 최초 로그인에는 아직 session cookie가 없으므로 endpoint 자체를 보호해 login CSRF를 막는다.
    if (!hasSessionCookie && !isLoginRequest(req)) return true;

    const origin = requestOrigin(req);
    if (origin && trustedWebOrigins().includes(origin)) return true;

    await this.events.record({ type: 'csrf_origin_blocked', failureCode: origin ? 'origin_not_allowed' : 'origin_missing', req });
    throw new ForbiddenException('허용되지 않은 요청 출처입니다. 다시 로그인해 주세요.');
  }
}
