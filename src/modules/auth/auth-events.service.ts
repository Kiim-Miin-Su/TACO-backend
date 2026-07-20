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

export const AUTH_EVENTS = 'auth_events';

export type AuthEventType =
  | 'login_success' | 'login_failure' | 'logout'
  // [TBO-29C C5] 비로그인 복구 흐름 — 계정 열거 방지를 위해 결과와 무관하게 요청 자체를 기록.
  | 'recover_id_requested' | 'recover_id_completed' | 'password_reset_requested' | 'password_reset_completed' // [TBO-31 C5] OTP판 아이디 찾기 완료
  // [대표 지시 ④ 2026-07-16] 폐기된 refresh token 재사용(유출 신호) — 전 토큰 무효화와 함께 기록.
  | 'refresh_reuse_blocked'
  // [TBO-34 C1] HttpOnly cookie 상태 변경의 Origin/Referer 검증 실패 — raw origin/IP 미저장.
  | 'csrf_origin_blocked';

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

  constructor(private readonly store: PostgresCollectionStore) {}

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
      this.logger.warn(`auth_event 기록 실패(${input.type}): ${err instanceof Error ? err.message : err}`);
    }
  }
}
