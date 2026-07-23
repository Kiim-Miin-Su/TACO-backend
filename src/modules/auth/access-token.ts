// [TBO-34 C2-C 2026-07-23] 액세스 토큰 추출의 **단일 진실원** — Bearer(테스트·이행 호환) 우선,
//  없으면 HttpOnly access cookie. 종전엔 RolesGuard와 SuperAdminGuard가 각자 추출 로직을 들고 있었고
//  C1(HttpOnly 전환) 때 RolesGuard만 갱신돼 SuperAdminGuard 전용 라우트(강사 직접 등록·대표 직접 수정·
//  가입신청 삭제·인증 재발송)가 cookie-only 브라우저 세션에서 401이 나는 잠복 결함이 있었다.
//  이제 두 가드 모두 이 함수 하나만 소비한다(추출 사본 0).
import type { Request } from 'express';
import { ACCESS_COOKIE, readCookie } from './browser-session';

export function extractAccessToken(req: Pick<Request, 'headers'>): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  return bearer || readCookie(req, ACCESS_COOKIE);
}

/** 이 요청이 Bearer 헤더로 인증했는가 — sudo 게이트의 테스트·이행 호환 판정(브라우저는 항상 cookie). */
export function isBearerRequest(req: Pick<Request, 'headers'>): boolean {
  return !!req.headers.authorization?.replace(/^Bearer\s+/i, '');
}
