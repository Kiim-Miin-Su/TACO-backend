// [참조/처리] RBAC 가드. @UseGuards(RolesGuard)를 붙인 컨트롤러/핸들러에서:
//  1) 요청 Authorization: Bearer 토큰 → AuthService.verify로 JwtClaims 파싱(실패 시 401).
//  2) Reflector로 핸들러/클래스의 @Roles(...) 메타(ROLES_KEY)를 읽어 교집합 검사(불충족 시 403).
//     [주의] @Roles가 없으면 이 가드는 **검사 없이 통과 = 공개**다(아래 39행). "로그인만 필요"가 아님.
//     → 로그인 필수 라우트는 반드시 @Roles(...STAFF_ROLES)를 명시할 것. (코드리뷰 2026-07-03 D1 — H1·H2 원인)
//  참조처: events/expenses/payouts/reports 등 관리자 전용 쓰기 컨트롤러. AuthModule을 import해야 주입됨.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type JwtClaims } from './auth.service';
import { ROLES_KEY, type AppRole } from './roles.decorator';

// 역할 기반 인가 가드. @Roles(...)로 선언된 라우트만 검사한다.
//  1) Authorization: Bearer <token> 백엔드 서명 검증
//  2) claims.roles 와 허용 역할 교집합 확인
//  3) 통과 시 req.user = claims (다운스트림 본인확인용)
// 디버깅: 거부 사유를 '대략'만 콘솔에 남긴다(토큰·클레임 내용은 노출하지 않음 → 정보 유출 방지).
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly log = new Logger('RolesGuard');

  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // @Roles 미선언 라우트는 이 가드가 관여하지 않음(공개/기존 동작 유지).
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtClaims }>();
    const route = `${req.method} ${req.path}`;
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) {
      this.log.warn(`거부(비로그인): ${route}`); // 토큰 없음 — 로그인 필요
      throw new UnauthorizedException('인증 토큰이 없습니다.');
    }

    let claims: JwtClaims;
    try {
      claims = this.auth.verify(token);
    } catch {
      this.log.warn(`거부(토큰무효): ${route}`); // 서명/만료 실패 — 상세는 남기지 않음
      throw new UnauthorizedException('유효하지 않은 토큰입니다.');
    }

    const ok = (claims.roles ?? []).some((r) => required.includes(r as AppRole));
    if (!ok) {
      // 권한 부족 — 필요 역할만 남기고(참고), 사용자 역할 전체는 남기지 않음(최소 노출).
      this.log.warn(`거부(권한부족): ${route} — 필요=${required.join('|')}`);
      throw new ForbiddenException('접근 권한이 없습니다.');
    }

    req.user = claims;
    return true;
  }
}
