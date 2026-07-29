// [대표 지시 ④ 2026-07-16] refresh token 발급·회전·폐기 — httpOnly 쿠키로만 운반되는 불투명
//  랜덤 토큰(JWT 아님). 저장은 sha256 hash만(불변식 §5-3: 원문 토큰을 저장·로그·응답에 남기지 않음 —
//  발급 응답의 Set-Cookie 1회가 유일한 원문 노출).
//  회전 규약: /auth/refresh 1회 = 새 토큰 발급 + 구 토큰 폐기(replaced_by_id 링크).
//  **폐기 토큰 재사용 = 유출 신호** → 해당 사용자의 모든 refresh 토큰 즉시 무효 + auth_events 기록.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import type { BaseRow } from '../../common/types/base';
import { AUTH_REFRESH_TOKENS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { PostgresConnectionService } from '../../database/postgres-connection.service';

export type RefreshTokenRow = {
  userId: number;
  tokenHash: string;
  authVersion: number;
  expiresAt: string;
  revokedAt?: string | null;
  replacedById?: number | null;
  userAgent?: string | null;
} & BaseRow;
export type RefreshRotationResult =
  | { ok: true; previous: RefreshTokenRow; next: { raw: string; row: RefreshTokenRow } }
  | { ok: false; reason: 'missing' | 'expired' | 'reuse'; userId?: number };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** TTL(일) — env REFRESH_TOKEN_TTL_DAYS, 기본 14일. access token(JWT_EXPIRES_IN, 기본 1h)보다 길게. */
const ttlDays = (): number => {
  const parsed = Number(process.env.REFRESH_TOKEN_TTL_DAYS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 14;
};

@Injectable()
export class RefreshTokensService implements OnModuleInit {
  private readonly logger = new Logger(RefreshTokensService.name);
  private readonly rotationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly postgres: PostgresConnectionService,
  ) {}

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

  /**
   * 같은 브라우저의 계정 교체. 제시된 이전 refresh를 폐기하고 새 토큰을 발급하는 과정을
   * 한 DB transaction으로 묶어 활성 쿠키와 활성 DB 행이 서로 다른 사용자를 가리키지 않게 한다.
   */
  async replaceBrowserSession(
    previousRaw: string | undefined,
    userId: number,
    authVersion: number,
    userAgent?: string | null,
  ): Promise<{ raw: string; row: RefreshTokenRow }> {
    return this.postgres.transaction(async () => {
      if (previousRaw) await this.revokeByRaw(previousRaw);
      return this.issue(userId, authVersion, userAgent);
    });
  }

  /**
   * Refresh 회전의 원자 경계. PostgreSQL에서는 token row를 FOR UPDATE로 잠근 뒤 successor insert와
   * predecessor revoke/link를 같은 transaction에서 커밋한다. in-memory e2e도 token별 mutex로
   * 같은 동시성 의미를 유지한다.
   */
  async rotate(raw: string, userAgent?: string | null): Promise<RefreshRotationResult> {
    const key = sha256(raw);
    const previous = this.rotationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.rotationLocks.set(key, chain);
    await previous;
    try {
      return await this.postgres.transaction(async () => {
        const row = await this.findForRotation(raw);
        if (!row) return { ok: false, reason: 'missing' };
        if (row.revokedAt != null) {
          const count = await this.revokeAllForUser(row.userId);
          this.logger.warn(`refresh 재사용 감지 — user=${row.userId} 전 토큰 ${count}건 무효화`);
          return { ok: false, reason: 'reuse', userId: row.userId };
        }
        if (Date.parse(row.expiresAt) <= Date.now()) {
          await this.store.update<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, row.id, {
            revokedAt: new Date().toISOString(),
          } as Partial<Omit<RefreshTokenRow, keyof BaseRow>>);
          return { ok: false, reason: 'expired', userId: row.userId };
        }
        const next = await this.issue(row.userId, row.authVersion, userAgent);
        await this.store.update<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, row.id, {
          revokedAt: new Date().toISOString(),
          replacedById: next.row.id,
        } as Partial<Omit<RefreshTokenRow, keyof BaseRow>>);
        return { ok: true, previous: row, next };
      });
    } finally {
      release();
      if (this.rotationLocks.get(key) === chain) this.rotationLocks.delete(key);
    }
  }

  private async findForRotation(raw: string): Promise<RefreshTokenRow | undefined> {
    if (!this.postgres.ready) return this.findByRaw(raw);
    const [row] = await this.postgres.query<{
      id: number;
      user_id: number;
      token_hash: string;
      auth_version: number;
      expires_at: string | Date;
      revoked_at?: string | Date | null;
      replaced_by_id?: number | null;
      user_agent?: string | null;
      created_at: string | Date;
      updated_at: string | Date;
      deleted_at?: string | Date | null;
      deleted_by?: number | null;
    }>(
      `SELECT * FROM auth_refresh_tokens
        WHERE token_hash = $1 AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE`,
      [sha256(raw)],
    );
    if (!row) return undefined;
    const iso = (value: string | Date | null | undefined) =>
      value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    return {
      id: Number(row.id),
      userId: Number(row.user_id),
      tokenHash: row.token_hash,
      authVersion: Number(row.auth_version),
      expiresAt: iso(row.expires_at)!,
      revokedAt: iso(row.revoked_at),
      replacedById: row.replaced_by_id ?? null,
      userAgent: row.user_agent ?? null,
      createdAt: iso(row.created_at)!,
      updatedAt: iso(row.updated_at)!,
      deletedAt: iso(row.deleted_at),
      deletedBy: row.deleted_by ?? undefined,
    };
  }

  /** 원문 토큰으로 행 조회(hash 대조). 없으면 undefined — 메시지는 호출부가 generic 401로 통일. */
  async findByRaw(raw: string): Promise<RefreshTokenRow | undefined> {
    const rows = await this.store.findActive<RefreshTokenRow>(AUTH_REFRESH_TOKENS_SPEC, {
      where: { tokenHash: sha256(raw) } as Partial<RefreshTokenRow>,
      limit: 1,
    });
    return rows[0];
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
