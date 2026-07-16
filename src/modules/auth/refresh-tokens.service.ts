// [대표 지시 ④ 2026-07-16] refresh token 발급·회전·폐기 — httpOnly 쿠키로만 운반되는 불투명
//  랜덤 토큰(JWT 아님). 저장은 sha256 hash만(불변식 §5-3: 원문 토큰을 저장·로그·응답에 남기지 않음 —
//  발급 응답의 Set-Cookie 1회가 유일한 원문 노출).
//  회전 규약: /auth/refresh 1회 = 새 토큰 발급 + 구 토큰 폐기(replaced_by_id 링크).
//  **폐기 토큰 재사용 = 유출 신호** → 해당 사용자의 모든 refresh 토큰 즉시 무효 + auth_events 기록.
import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { BaseRow } from '../../common/types/base';
import { AUTH_REFRESH_TOKENS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';

export type RefreshTokenRow = {
  userId: number;
  tokenHash: string;
  authVersion: number;
  expiresAt: string;
  revokedAt?: string | null;
  replacedById?: number | null;
  userAgent?: string | null;
} & BaseRow;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** TTL(일) — env REFRESH_TOKEN_TTL_DAYS, 기본 14일. access token(JWT_EXPIRES_IN, 기본 1h)보다 길게. */
const ttlDays = (): number => {
  const parsed = Number(process.env.REFRESH_TOKEN_TTL_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
};

@Injectable()
export class RefreshTokensService implements OnModuleInit {
  private readonly logger = new Logger(RefreshTokensService.name);

  constructor(private readonly store: PostgresCollectionStore) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensureReady(AUTH_REFRESH_TOKENS_SPEC);
  }

  /** 발급 — 원문 토큰(64 hex)은 반환 즉시 쿠키로만 나가고 저장소에는 hash만 남는다. */
  async issue(userId: number, authVersion: number, userAgent?: string | null): Promise<{ raw: string; row: RefreshTokenRow }> {
    const raw = randomBytes(32).toString('hex');
    const row = await this.store.insert<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, {
      userId,
      tokenHash: sha256(raw),
      authVersion,
      expiresAt: new Date(Date.now() + ttlDays() * 86_400_000).toISOString(),
      revokedAt: null,
      replacedById: null,
      userAgent: userAgent?.slice(0, 300) ?? null,
    } as Omit<RefreshTokenRow, keyof BaseRow>);
    return { raw, row };
  }

  /** 원문 토큰으로 행 조회(hash 대조). 없으면 undefined — 메시지는 호출부가 generic 401로 통일. */
  async findByRaw(raw: string): Promise<RefreshTokenRow | undefined> {
    const rows = await this.store.findActive<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, {
      where: { tokenHash: sha256(raw) } as Partial<RefreshTokenRow>,
      limit: 1,
    });
    return rows[0];
  }

  /**
   * 회전 전 검증 — 폐기 재사용(유출 신호)은 사용자 전 토큰 무효화 후 401, 만료는 401.
   * 통과 시 행을 반환(회전 완료는 markRotated — 새 토큰 발급 후 링크).
   */
  async assertRotatable(raw: string): Promise<RefreshTokenRow> {
    const row = await this.findByRaw(raw);
    if (!row) throw new UnauthorizedException('세션이 더 이상 유효하지 않습니다. 다시 로그인해 주세요.');
    if (row.revokedAt != null) {
      // 재사용 감지 — 같은 체인의 어떤 토큰이 탈취됐는지 알 수 없으므로 전부 폐기(가족 무효화).
      const n = await this.revokeAllForUser(row.userId);
      this.logger.warn(`refresh 재사용 감지 — user=${row.userId} 전 토큰 ${n}건 무효화`);
      throw new UnauthorizedException('세션 갱신이 차단되었습니다. 다시 로그인해 주세요.');
    }
    if (Date.parse(row.expiresAt) <= Date.now()) {
      throw new UnauthorizedException('세션이 만료되었습니다. 다시 로그인해 주세요.');
    }
    return row;
  }

  /** 회전 완료 — 구 토큰을 폐기하고 대체 토큰 id를 링크(감사 추적). */
  async markRotated(oldId: number, replacedById: number): Promise<void> {
    await this.store.update<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, oldId, {
      revokedAt: new Date().toISOString(),
      replacedById,
    } as Partial<Omit<RefreshTokenRow, keyof BaseRow>>);
  }

  /** 로그아웃 — 제시된 토큰만 폐기(다른 기기 세션은 유지). 없는 토큰은 조용히 무시(멱등). */
  async revokeByRaw(raw: string): Promise<void> {
    const row = await this.findByRaw(raw);
    if (row && row.revokedAt == null) {
      await this.store.update<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, row.id, {
        revokedAt: new Date().toISOString(),
      } as Partial<Omit<RefreshTokenRow, keyof BaseRow>>);
    }
  }

  /** 사용자 전 토큰 무효화(재사용 감지·계정 상태 불일치) — 폐기된 건 제외하고 무효화 건수 반환. */
  async revokeAllForUser(userId: number): Promise<number> {
    const rows = await this.store.findActive<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, {
      where: { userId } as Partial<RefreshTokenRow>,
    });
    const active = rows.filter((r) => r.revokedAt == null);
    for (const r of active) {
      await this.store.update<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, r.id, {
        revokedAt: new Date().toISOString(),
      } as Partial<Omit<RefreshTokenRow, keyof BaseRow>>);
    }
    return active.length;
  }
}
