import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService, type JwtClaims } from './auth.service';
import { AccountStateService } from '../../database/account-state.service';

// 대표(super_admin) 전용 가드 — 승인 등 고유 권한 API 보호.
// Authorization: Bearer <token> 를 백엔드에서 서명 검증하고 roles에 super_admin 포함 여부 확인.
// [TBO-28B] ① 검증된 claims를 req.user로 부착(승인 command가 actor=JWT sub만 쓰도록 — 불변식 §5-4)
//           ② 권위 DB 대조(AccountStateService) — role/status 변경(auth_version 증가) 시 구 토큰 즉시 거부.
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly accounts: AccountStateService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtClaims }>();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('인증 토큰이 없습니다.');
    let claims: JwtClaims;
    try {
      claims = this.auth.verify(token);
    } catch {
      throw new UnauthorizedException('유효하지 않은 토큰입니다.');
    }
    if (!claims.roles?.includes('super_admin')) throw new ForbiddenException('대표(super_admin) 권한이 필요합니다.');
    const verdict = await this.accounts.verifyClaims(claims);
    if (!verdict.ok) throw new UnauthorizedException('세션이 더 이상 유효하지 않습니다. 다시 로그인해 주세요.');
    req.user = claims;
    return true;
  }
}
