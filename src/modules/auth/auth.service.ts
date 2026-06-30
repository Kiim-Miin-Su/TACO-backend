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
  // 운영(NODE_ENV=production)에서는 JWT_SECRET 미설정 시 부팅 실패(약한 기본키 서명 방지).
  private readonly secret: string = (() => {
    const s = process.env.JWT_SECRET;
    if (!s) {
      if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET 환경변수가 필요합니다(운영).');
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
