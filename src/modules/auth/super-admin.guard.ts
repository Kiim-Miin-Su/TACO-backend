import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

// 대표(super_admin) 전용 가드 — 승인 등 고유 권한 API 보호.
// Authorization: Bearer <token> 를 백엔드에서 서명 검증하고 roles에 super_admin 포함 여부 확인.
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('인증 토큰이 없습니다.');
    let claims;
    try {
      claims = this.auth.verify(token);
    } catch {
      throw new UnauthorizedException('유효하지 않은 토큰입니다.');
    }
    if (!claims.roles?.includes('super_admin')) throw new ForbiddenException('대표(super_admin) 권한이 필요합니다.');
    return true;
  }
}
