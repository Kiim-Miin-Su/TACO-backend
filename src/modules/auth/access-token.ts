// [TBO-34 C2-C 2026-07-23] 액세스 토큰 추출의 **단일 진실원** — Bearer(테스트·이행 호환) 우선,
//  없으면 HttpOnly access cookie. TBO-74C부터 인증/인가는 RolesGuard 하나로 수렴했고
//  대표 전용 범위도 capability metadata로 판정한다.
import type { Request } from 'express';
import { ACCESS_COOKIE, readCookie } from './browser-session';

export function extractAccessToken(req: Pick<Request, 'headers'>): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return bearer || readCookie(req, ACCESS_COOKIE);
}
