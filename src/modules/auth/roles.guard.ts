// [참조/처리] 전역 인증/RBAC 가드:
//  1) 요청 Authorization: Bearer 토큰 → AuthService.verify로 JwtClaims 파싱(실패 시 401).
//  2) Reflector로 핸들러/클래스의 @Roles(...) 메타(ROLES_KEY)를 읽어 교집합 검사(불충족 시 403).
//  2) @Roles가 있으면 역할 교집합까지 검사한다. @Public만 인증을 생략한다.
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
import { AccountStateService } from '../../database/account-state.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/** 임시 비밀번호 상태에서 허용하는 최소 복구 경로. 프론트 숨김과 무관하게 서버가 강제한다.
 *  [대표 추가요청 2026-07-16] 첫 로그인 통합 설정에 **이메일 인증(OTP)**·국가/시간대 카탈로그가
 *  필요해져 profile-verifications 3종·catalog/countries(읽기 전용)를 허용 목록에 편입.
 *  여전히 업무 API(스케줄·결제 등)는 전부 차단된다. */
export function isCredentialRecoveryRoute(method: string, path: string): boolean {
  const normalized = path.replace(/^\/api/, '');
  const key = `${method.toUpperCase()} ${normalized}`;
  return key === 'PATCH /users/me/credentials' || key === 'GET /auth/me' || key === 'POST /auth/logout'
    || key === 'POST /profile-verifications'
    || /^POST \/profile-verifications\/\d+\/(confirm|resend)$/.test(key)
    || key === 'GET /catalog/countries';
}

// 기본은 로그인 필수이며 @Roles(...)가 있으면 역할도 검사한다.
//  1) Authorization: Bearer <token> 백엔드 서명 검증
//  2) claims.roles 와 허용 역할 교집합 확인
//  2.5) [TBO-28B] 권위 DB 대조(AccountStateService) — status!=active·auth_version 불일치·role 변경이면
//       만료 전 토큰도 즉시 401(다중 인스턴스 동일 판정 — Postgres 모드는 요청마다 users 1행 SELECT).
//  3) 통과 시 req.user = claims (다운스트림 본인확인용)
// 디버깅: 거부 사유를 '대략'만 콘솔에 남긴다(토큰·클레임 내용은 노출하지 않음 → 정보 유출 방지).
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly log = new Logger('RolesGuard');

  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
    private readonly accounts: AccountStateService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
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

    const ok = !required?.length || (claims.roles ?? []).some((r) => required.includes(r as AppRole));
    if (!ok) {
      // 권한 부족 — 필요 역할만 남기고(참고), 사용자 역할 전체는 남기지 않음(최소 노출).
      this.log.warn(`거부(권한부족): ${route} — 필요=${required.join('|')}`);
      throw new ForbiddenException('접근 권한이 없습니다.');
    }

    // [TBO-28B] 권위 대조 — 서명이 유효해도 계정 상태/버전이 바뀌었으면 즉시 거부.
    const verdict = await this.accounts.verifyClaims(claims);
    if (!verdict.ok) {
      this.log.warn(`거부(계정상태): ${route} — ${verdict.code}`);
      throw new UnauthorizedException('세션이 더 이상 유효하지 않습니다. 다시 로그인해 주세요.');
    }
    if (verdict.mustChangePassword && !isCredentialRecoveryRoute(req.method, req.path)) {
      this.log.warn(`거부(임시비밀번호): ${route}`);
      throw new ForbiddenException('임시 비밀번호를 먼저 변경해 주세요.');
    }

    req.user = claims;
    return true;
  }
}
