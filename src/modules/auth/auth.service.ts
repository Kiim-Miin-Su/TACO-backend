import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';

export type JwtClaims = {
  sub: number; // user id
  name: string;
  roles: string[]; // user_roles
}

/**
 * JWT 서명/검증은 백엔드 책임. (프론트는 jwt-decode로 읽기만)
 * 운영에서는 JWT_SECRET 환경변수를 반드시 설정하세요.
 */
@Injectable()
export class AuthService {
  // JWT_SECRET 권장(운영). 미설정 시 부팅을 막지 않고(서버리스 전체 다운 방지) 경고만 남기고
  // 고정 기본키로 동작 — 데모는 즉시 사용 가능, 운영은 반드시 JWT_SECRET 설정 권장.
  private readonly secret: string = (() => {
    const s = process.env.JWT_SECRET;
    if (!s) {
      // eslint-disable-next-line no-console
      console.warn('[auth] JWT_SECRET 미설정 — 기본 개발키 사용 중. 운영에서는 반드시 JWT_SECRET을 설정하세요.');
      return 'dev-secret-change-me';
    }
    return s;
  })();
  private readonly expiresIn: string = process.env.JWT_EXPIRES_IN ?? '1h';

  sign(claims: JwtClaims): string {
    return jwt.sign(claims, this.secret, {
      expiresIn: this.expiresIn as jwt.SignOptions['expiresIn'],
    });
  }

  verify(token: string): JwtClaims & jwt.JwtPayload {
    try {
      return jwt.verify(token, this.secret) as JwtClaims & jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
