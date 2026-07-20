// [TBO-28B] /auth/login 전용 rate limit — 무차별 대입(brute force) 완화.
//  Express req.ip는 명시된 TRUST_PROXY hop/CIDR만 신뢰한다. raw x-forwarded-for를 직접 읽지 않는다.
//  storage는 PostgreSQL advisory-lock counter로 다중 서버리스 인스턴스가 공유한다.
//  테스트: NODE_ENV=test에서는 기본 skip(전 e2e가 로그인 다회 호출) — THROTTLE_E2E=1로 명시 활성.
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    return String((req as { ip?: string }).ip ?? 'unknown');
  }

  protected async getErrorMessage(): Promise<string> {
    return '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  }
}
