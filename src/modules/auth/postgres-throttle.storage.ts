import { Logger } from '@nestjs/common';
import { isProduction } from '../../common/env'; // [TBO-34 C3] 환경 판정 단일 진실원
import {
  ThrottlerStorageService,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { PostgresConnectionService } from '../../database/postgres-connection.service';

type RateLimitRow = {
  total_hits: number | string;
  window_expires_at: Date | string;
  blocked_until: Date | string | null;
};
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const secondsRemaining = (futureMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((futureMs - nowMs) / 1000));

/**
 * Nest throttler key는 route+tracker를 이미 sha256한 64자 값이다. 원문 IP/webId는 저장하지 않는다.
 * PostgreSQL advisory lock으로 같은 key의 두 인스턴스 increment를 직렬화한다.
 */
export class PostgresThrottleStorage implements ThrottlerStorage {
  private readonly logger = new Logger(PostgresThrottleStorage.name);
  private readonly fallback = new ThrottlerStorageService();
  private successfulIncrements = 0;
  // 앱 부팅 시점 posture를 고정한다. 일부 e2e가 요청 한 건만 NODE_ENV를 production으로 바꾸더라도
  // test 앱을 실제 production 인스턴스로 오판하지 않는다.
  private readonly requireSharedStore = isProduction();

  constructor(private readonly pg: PostgresConnectionService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.pg.ready) {
      if (this.requireSharedStore) {
        throw new Error('[throttle] production PostgreSQL 연결이 없어 공유 rate limit을 적용할 수 없습니다.');
      }
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }

    try {
      const result = await this.pg.transaction(async () => {
        await this.pg.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        const [clock] = await this.pg.query<{ now: Date | string }>('SELECT clock_timestamp() AS now');
        const nowMs = new Date(clock.now).getTime();
        const [existing] = await this.pg.query<RateLimitRow>(
          `SELECT total_hits, window_expires_at, blocked_until
             FROM auth_rate_limits WHERE key_hash=$1 FOR UPDATE`,
          [key],
        );

        const previousWindowMs = existing ? new Date(existing.window_expires_at).getTime() : 0;
        const previousBlockMs = existing?.blocked_until ? new Date(existing.blocked_until).getTime() : 0;
        const reset = !existing || previousWindowMs <= nowMs || (previousBlockMs > 0 && previousBlockMs <= nowMs);
        const wasBlocked = !reset && previousBlockMs > nowMs;
        const totalHits = reset ? 1 : wasBlocked ? Number(existing.total_hits) : Number(existing.total_hits) + 1;
        const windowExpiresMs = reset ? nowMs + ttl : previousWindowMs;
        const blockedUntilMs = wasBlocked
          ? previousBlockMs
          : totalHits > limit
            ? nowMs + blockDuration
            : 0;

        await this.pg.query(
          `INSERT INTO auth_rate_limits
             (key_hash, throttler_name, total_hits, window_expires_at, blocked_until, updated_at)
           VALUES ($1, $2, $3, $4, $5, clock_timestamp())
           ON CONFLICT (key_hash) DO UPDATE SET
             throttler_name=EXCLUDED.throttler_name,
             total_hits=EXCLUDED.total_hits,
             window_expires_at=EXCLUDED.window_expires_at,
             blocked_until=EXCLUDED.blocked_until,
             updated_at=clock_timestamp()`,
          [
            key,
            throttlerName.slice(0, 40),
            totalHits,
            new Date(windowExpiresMs),
            blockedUntilMs ? new Date(blockedUntilMs) : null,
          ],
        );

        return {
          totalHits,
          timeToExpire: secondsRemaining(windowExpiresMs, nowMs),
          isBlocked: blockedUntilMs > nowMs,
          timeToBlockExpire: secondsRemaining(blockedUntilMs, nowMs),
        };
      });

      this.successfulIncrements += 1;
      if (this.successfulIncrements % 100 === 0) {
        try {
          await this.pg.query(
            `DELETE FROM auth_rate_limits
              WHERE window_expires_at < clock_timestamp() - INTERVAL '1 day'
                AND (blocked_until IS NULL OR blocked_until < clock_timestamp() - INTERVAL '1 day')`,
          );
        } catch (cleanupError) {
          this.logger.warn(
            `만료된 auth rate-limit 정리 실패: ${cleanupError instanceof Error ? cleanupError.message : 'unknown error'}`,
          );
        }
      }
      return result;
    } catch (error) {
      const code = (error as { code?: string; driverError?: { code?: string } }).code
        ?? (error as { driverError?: { code?: string } }).driverError?.code;
      if (this.requireSharedStore || code !== '42P01') throw error;
      this.logger.warn('auth_rate_limits migration 미적용 — non-production in-memory throttle로 폴백');
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}
