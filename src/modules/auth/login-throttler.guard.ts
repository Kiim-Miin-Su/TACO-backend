// [TBO-28B] /auth/login 전용 rate limit — 무차별 대입(brute force) 완화.
//  Vercel 등 프록시 뒤에서는 req.ip가 프록시 IP가 되므로 x-forwarded-for 첫 IP를 tracker로 쓴다.
//  ⚠ 한계(문서화): storage가 in-memory라 다중 서버리스 인스턴스에서는 인스턴스별 카운트다.
//    분산 storage(redis 등) 승격은 후속 — 단일 인스턴스/저트래픽 사내 QA 범위에서는 유효.
//  테스트: NODE_ENV=test에서는 기본 skip(전 e2e가 로그인 다회 호출) — THROTTLE_E2E=1로 명시 활성.
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class LoginThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req as { headers?: Record<string, unknown> }).headers ?? {};
    const forwarded = String(headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
    return String((req as { ip?: string }).ip ?? 'unknown');
  }

  protected async getErrorMessage(): Promise<string> {
    return '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  }
}
