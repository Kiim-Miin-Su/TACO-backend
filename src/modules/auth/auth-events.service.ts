// [TBO-28B] 인증 보안 이벤트(auth_events) — append-only. 업무 audit_log와 분리.
//  기록: login_success · login_failure · logout. users.last_login_at은 최신 성공 시각 summary이고
//  전체 이력 진실원은 이 테이블이다(erd.dbml 노트).
//  불변식: password/password hash/JWT/refresh token/raw IP/DB URL을 절대 저장하지 않는다.
//  실패 로그인은 user_id 없이 attempted_web_id_hash(sha256)만 남긴다. update/remove 경로 없음.
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request } from 'express';
import type { BaseRow } from '../../common/types/base';
import { AUTH_EVENTS_SPEC } from '../../database/calendar-asset-specs';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';
import { PostgresConnectionService } from '../../database/postgres-connection.service';
import { InMemoryDatabase } from '../../database/in-memory.database';
import type { AuthEventQuery, AuthEventRecord, AuthEventType } from '@kms545487/contracts';

export const AUTH_EVENTS = 'auth_events';

export const AUTH_EVENT_TYPES = [
  'login_success', 'login_failure', 'logout',
  'recover_id_requested', 'recover_id_completed',
  'password_reset_requested', 'password_reset_completed',
  'refresh_reuse_blocked', 'csrf_origin_blocked',
] as const satisfies readonly AuthEventType[];

export type AuthEvent = {
  eventType: AuthEventType;
  userId?: number | null; // 실패 로그인은 null 허용
  attemptedWebIdHash?: string | null;
  requestId?: string | null;
  ipHash?: string | null;
  userAgent?: string | null;
  success: boolean;
  failureCode?: string | null;
  at: string;
} & BaseRow;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthEventsService implements OnModuleInit {
  private readonly logger = new Logger(AuthEventsService.name);

  constructor(
    private readonly store: PostgresCollectionStore,
    private readonly postgres: PostgresConnectionService,
    private readonly memory: InMemoryDatabase,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.ensureReady(AUTH_EVENTS_SPEC);
  }

  /** 이벤트 1건 기록. 인증 가용성 우선 — 기록 실패는 warn 로그 후 삼킨다(로그인 자체를 막지 않음). */
  async record(input: {
    type: AuthEventType;
    userId?: number;
    attemptedWebId?: string; // 원문은 저장하지 않고 sha256만
    failureCode?: string;
    req?: Pick<Request, 'headers' | 'ip'>;
  }): Promise<void> {
    try {
      const headers = input.req?.headers ?? {};
      const clientIp = input.req?.ip?.trim();
      const requestId = String(headers['x-request-id'] ?? headers['x-vercel-id'] ?? '').slice(0, 64) || null;
      const userAgent = String(headers['user-agent'] ?? '').slice(0, 300) || null;
      await this.store.insert<AuthEvent>(AUTH_EVENTS_SPEC, {
        eventType: input.type,
        userId: input.userId ?? null,
        attemptedWebIdHash: input.attemptedWebId ? sha256(input.attemptedWebId.trim().toLowerCase()) : null,
        requestId,
        ipHash: clientIp ? sha256(clientIp) : null,
        userAgent,
        success: input.type === 'login_success' || input.type === 'logout'
          || input.type === 'recover_id_completed' || input.type === 'password_reset_completed',
        failureCode: input.failureCode ?? null,
        at: new Date().toISOString(),
      } as Omit<AuthEvent, keyof BaseRow>);
    } catch (err) {
      // [TBO-79 F5] 기록 실패는 요청을 깨뜨리지 않는다 — DB 일시 장애가 로그인 자체를 막으면 안 된다.
      //  다만 **보안 이벤트**(실패·차단)가 유실되는 건 단순 경고가 아니라 관측 대상이므로 error로
      //  올린다. 성공 이벤트는 종전대로 warn. 알림 임계는 운영 대시보드 몫(owner).
      const message = `auth_event 기록 실패(${input.type}): ${err instanceof Error ? err.message : err}`;
      if (input.type === 'login_success' || input.type === 'logout') this.logger.warn(message);
      else this.logger.error(message);
    }
  }

  /** 관리자 보안 조회용 bounded projection. hash/request-id/user-agent는 의도적으로 반환하지 않는다. */
  async list(query: AuthEventQuery): Promise<AuthEventRecord[]> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    await this.postgres.ensureInitialized();
    if (!this.postgres.ready) {
      return this.memory.findAll<AuthEvent>(AUTH_EVENTS)
        .filter((row) => query.userId == null || row.userId === query.userId)
        .filter((row) => query.eventType == null || row.eventType === query.eventType)
        .filter((row) => query.success == null || row.success === query.success)
        .filter((row) => query.from == null || row.at >= query.from)
        .filter((row) => query.to == null || row.at <= query.to)
        .sort((left, right) => right.id - left.id)
        .slice(0, limit)
        .map((row) => this.toRecord(row));
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (query.userId != null) add('user_id = ?', query.userId);
    if (query.eventType != null) add('event_type = ?', query.eventType);
    if (query.success != null) add('success = ?', query.success);
    if (query.from != null) add('at >= ?::timestamptz', query.from);
    if (query.to != null) add('at <= ?::timestamptz', query.to);
    params.push(limit);
    const rows = await this.postgres.query<{
      id: number;
      eventType: AuthEventType;
      userId: number | null;
      success: boolean;
      failureCode: string | null;
      at: Date | string;
    }>(
      `SELECT id, event_type AS "eventType", user_id AS "userId",
              success, failure_code AS "failureCode", at
         FROM auth_events
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY id DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      at: row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString(),
    }));
  }

  private toRecord(row: AuthEvent): AuthEventRecord {
    return {
      id: row.id,
      eventType: row.eventType,
      userId: row.userId ?? null,
      success: row.success,
      failureCode: row.failureCode ?? null,
      at: row.at,
    };
  }
}
