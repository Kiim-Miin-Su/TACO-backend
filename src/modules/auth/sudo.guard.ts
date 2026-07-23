import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type JwtClaims } from './auth.service';
import { SUDO_COOKIE } from './browser-session';
import { readCookie } from './browser-session';
import { isBearerRequest } from './access-token';

/**
 * [TBO-34 C2-C 2026-07-23] sudo(재인증) 서버측 강제 — 민감 계정 명령(강사 직접 등록·대표 직접 수정·
 * 가입신청 삭제)에 적용. 종전엔 FE sudo 게이트뿐이라 세션 탈취 시 스텝업 없이 전 계정 수정이
 * 가능했다(리뷰 보안 ①). 규약:
 *  - 브라우저(cookie 세션): POST /auth/reauth 성공 시 발급되는 단명 HttpOnly sudo 쿠키 필수 —
 *    없거나 만료·타인 것이면 403(코드 SUDO_REQUIRED — FE가 재인증 모달 재출력).
 *  - Bearer 헤더 인증: 통과(테스트·이행 호환 — C1 규약상 production 응답은 raw 토큰을 브라우저 JS에
 *    노출하지 않으므로 XSS로 Bearer를 얻을 수 없다).
 * 반드시 인증 가드(SuperAdminGuard/RolesGuard) 뒤에 배치 — req.user가 부착된 뒤 sub 대조.
 */
@Injectable()
export class SudoGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtClaims }>();
    if (isBearerRequest(req)) return true; // 테스트·이행 호환(브라우저는 항상 cookie 경로)
    const raw = readCookie(req, SUDO_COOKIE);
    if (!raw) {
      throw new ForbiddenException({ code: 'SUDO_REQUIRED', message: '민감 작업에는 비밀번호 재확인이 필요합니다.' });
    }
    const sudo = this.auth.verifySudo(raw); // 만료·위조 시 401
    if (req.user?.sub !== sudo.sub) {
      throw new ForbiddenException({ code: 'SUDO_REQUIRED', message: '재인증 정보가 현재 세션과 일치하지 않습니다.' });
    }
    return true;
  }
}
