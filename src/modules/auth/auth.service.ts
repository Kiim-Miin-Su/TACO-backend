import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

export type JwtClaims = {
  sub: number; // user id (= 강사면 도메인 강사 식별자 — 통일 2026-07-07, 별도 instructorId 폐기)
  name: string;
  roles: string[]; // user_roles
  // [TBO-28B] 발급 시점 users.auth_version. 가드가 권위 DB와 대조해 role/status/credential 변경 시
  //  만료 전 토큰도 즉시 거부한다(AccountStateService). 구 토큰(클레임 부재)=1로 간주.
  authVersion?: number;
}

/**
 * JWT 서명/검증은 백엔드 책임. (프론트는 jwt-decode로 읽기만)
 * 운영에서는 JWT_SECRET 환경변수를 반드시 설정하세요.
 */
@Injectable()
export class AuthService {
  // [TBO-15 B2 · 2026-07-07] JWT_SECRET 운영 강제(fail-fast).
  //  · 운영(NODE_ENV=production)에서 미설정 = 고정 dev키로 서명하는 치명적 취약 → **부팅 차단**(throw).
  //  · 개발/데모/테스트에서는 종전대로 고정 dev키 + 경고(즉시 사용 가능, e2e 유지).
  private readonly secret: string = (() => {
    const s = process.env.JWT_SECRET;
    if (s) return s;
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[auth] JWT_SECRET 환경변수가 설정되지 않았습니다 — 운영 배포에는 필수입니다(고정 개발키 서명 차단).');
    }
    // eslint-disable-next-line no-console
    console.warn('[auth] JWT_SECRET 미설정 — 개발 기본키 사용 중(운영에서는 반드시 설정).');
    return 'dev-secret-change-me';
  })();
  private readonly expiresIn: string = process.env.JWT_EXPIRES_IN ?? '1h';

  sign(claims: JwtClaims): string {
    return jwt.sign(claims, this.secret, {
      expiresIn: this.expiresIn as jwt.SignOptions['expiresIn'],
      algorithm: 'HS256', // [보안 2026-07-03] 서명 알고리즘 고정
    });
  }

  verify(token: string): JwtClaims & jwt.JwtPayload {
    try {
      // [보안 2026-07-03] algorithms 화이트리스트 — 'none'·alg confusion(RS/HS 혼동) 공격 차단
      return jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as JwtClaims & jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
