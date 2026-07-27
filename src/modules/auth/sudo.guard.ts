import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type JwtClaims } from './auth.service';
import { SUDO_COOKIE } from './browser-session';
import { readCookie } from './browser-session';

/**
 * [TBO-34 C2-C 2026-07-23] sudo(재인증) 서버측 강제 — 민감 계정 명령(강사 직접 등록·대표 직접 수정·
 * 가입신청 삭제)에 적용. 종전엔 FE sudo 게이트뿐이라 세션 탈취 시 스텝업 없이 전 계정 수정이
 * 가능했다(리뷰 보안 ①). 규약:
 *  - 브라우저(cookie 세션): POST /auth/reauth 성공 시 발급되는 단명 HttpOnly sudo 쿠키 필수 —
 *    없거나 만료·타인 것이면 403(코드 SUDO_REQUIRED — FE가 재인증 모달 재출력).
 *  - Bearer API 호출도 sudo cookie가 별도로 필요하다. access token만으로 step-up을 우회할 수 없다.
 * 반드시 중앙 인증 가드(RolesGuard) 뒤에 배치 — req.user가 부착된 뒤 sub 대조.
 */
@Injectable()
export class SudoGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtClaims }>();
    const raw = readCookie(req, SUDO_COOKIE);
    if (!raw) throw this.required('민감 작업에는 비밀번호 재확인이 필요합니다.');
    let sudo: { sub: number };
    try {
      sudo = this.auth.verifySudo(raw);
    } catch {
      throw this.required('재인증 정보가 만료되었거나 유효하지 않습니다.');
    }
    if (req.user?.sub !== sudo.sub) {
      throw this.required('재인증 정보가 현재 세션과 일치하지 않습니다.');
    }
    return true;
  }

  private required(message: string): ForbiddenException {
    return new ForbiddenException({ code: 'SUDO_REQUIRED', message });
  }
}
