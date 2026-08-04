// [TBO-28B] JWT 토큰의 권위 검증 — 서명만 믿지 않고 **현재 계정 상태를 권위 소스에서 대조**한다.
//  목적: role/status/credential 변경(auth_version 증가) 시 만료 전 기존 JWT를 즉시 거부.
//  Postgres 모드 = 요청마다 users 1행 SELECT(다중 인스턴스에서도 즉시 일관 — 28B 종료 조건).
//  in-memory 모드 = 메모리 컬렉션이 곧 권위.
//  DatabaseModule(@Global)에서 제공 — 중앙 RolesGuard가 모듈 import 추가 없이 주입받는다.
import { Injectable } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresConnectionService } from './postgres-connection.service';
import { normalizeQueryRows } from './postgres-row.util';
import type { RoleCapability } from '@kms545487/contracts';
import { resolveEffectiveCapabilities, type CapabilityOverride } from '../modules/auth/effective-capabilities';

type AccountState = {
  name: string;
  role: string;
  status: string;
  authVersion: number;
  deleted: boolean;
  mustChangePassword: boolean;
  effectiveCapabilities: RoleCapability[];
};

export type ClaimsToVerify = { sub: number; roles?: string[]; authVersion?: number };

export type ClaimsVerdict = {
  ok: true;
  name: string;
  role: string;
  mustChangePassword: boolean;
  effectiveCapabilities: RoleCapability[];
} | { ok: false; code: 'missing' | 'inactive' | 'stale_token' | 'role_changed' };

@Injectable()
export class AccountStateService {
  constructor(
    private readonly memory: InMemoryDatabase,
    private readonly postgres: PostgresConnectionService,
  ) {}

  /** 토큰 claims를 현재 계정 상태와 대조. 불일치 = 토큰 즉시 무효(가드가 401 처리). */
  async verifyClaims(claims: ClaimsToVerify): Promise<ClaimsVerdict> {
    const state = await this.load(claims.sub);
    if (!state || state.deleted) return { ok: false, code: 'missing' };
    if (state.status !== 'active') return { ok: false, code: 'inactive' };
    if ((claims.authVersion ?? 1) !== state.authVersion) return { ok: false, code: 'stale_token' };
    // role 변경은 auth_version 증가로 이미 무효화되지만 이중 방어로 대조한다.
    const tokenRole = claims.roles?.[0];
    if (tokenRole && tokenRole !== state.role) return { ok: false, code: 'role_changed' };
    return {
      ok: true,
      name: state.name,
      role: state.role,
      mustChangePassword: state.mustChangePassword,
      effectiveCapabilities: state.effectiveCapabilities,
    };
  }

  private async load(id: number): Promise<AccountState | undefined> {
    await this.postgres.ensureInitialized();
    if (this.postgres.ready) {
      const rows = normalizeQueryRows(await this.postgres.query(
        `SELECT u.name, u.role, u.status, u.auth_version, u.must_change_password, u.deleted_at,
                o.capability AS override_capability, o.effect AS override_effect
           FROM users u
           LEFT JOIN user_capability_overrides o
             ON o.user_id = u.id AND o.deleted_at IS NULL
          WHERE u.id = $1
          ORDER BY o.id ASC`,
        [id],
      ));
      const row = rows[0];
      if (!row) return undefined;
      const overrides = rows.flatMap((item): CapabilityOverride[] =>
        typeof item.override_capability === 'string'
          && (item.override_effect === 'allow' || item.override_effect === 'deny')
          ? [{ capability: item.override_capability, effect: item.override_effect }]
          : [],
      );
      const role = String(row.role);
      return {
        name: String(row.name),
        role,
        status: String(row.status),
        authVersion: row.auth_version == null ? 1 : Number(row.auth_version),
        deleted: row.deleted_at != null,
        mustChangePassword: row.must_change_password === true,
        effectiveCapabilities: resolveEffectiveCapabilities([role], overrides),
      };
    }
    type MemoryUserRow = { role: string; status: string; authVersion?: number; mustChangePassword?: boolean } & import('../common/types/base').BaseRow;
    const acc = this.memory.findById<MemoryUserRow>('users', id);
    if (!acc) return undefined;
    type MemoryOverrideRow = CapabilityOverride & import('../common/types/base').BaseRow & { userId: number };
    const overrides = this.memory.findByField<MemoryOverrideRow>('user_capability_overrides', 'userId', id);
    return {
      name: String((acc as MemoryUserRow & { name?: string }).name ?? ''),
      role: acc.role,
      status: acc.status,
      authVersion: acc.authVersion ?? 1,
      deleted: acc.deletedAt != null,
      mustChangePassword: acc.mustChangePassword === true,
      effectiveCapabilities: resolveEffectiveCapabilities([acc.role], overrides),
    };
  }
}
