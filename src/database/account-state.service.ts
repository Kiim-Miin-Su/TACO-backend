// [TBO-28B] JWT 토큰의 권위 검증 — 서명만 믿지 않고 **현재 계정 상태를 권위 소스에서 대조**한다.
//  목적: role/status/credential 변경(auth_version 증가) 시 만료 전 기존 JWT를 즉시 거부.
//  Postgres 모드 = 요청마다 users 1행 SELECT(다중 인스턴스에서도 즉시 일관 — 28B 종료 조건).
//  in-memory 모드 = 메모리 컬렉션이 곧 권위.
//  DatabaseModule(@Global)에서 제공 — 중앙 RolesGuard가 모듈 import 추가 없이 주입받는다.
import { Injectable } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresConnectionService } from './postgres-connection.service';
import { normalizeQueryRows } from './postgres-row.util';

type AccountState = {
  role: string;
  status: string;
  authVersion: number;
  deleted: boolean;
  mustChangePassword: boolean;
};

export type ClaimsToVerify = { sub: number; roles?: string[]; authVersion?: number };

export type ClaimsVerdict = { ok: true; mustChangePassword: boolean } | { ok: false; code: 'missing' | 'inactive' | 'stale_token' | 'role_changed' };

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
    return { ok: true, mustChangePassword: state.mustChangePassword };
  }

  private async load(id: number): Promise<AccountState | undefined> {
    await this.postgres.ensureInitialized();
    if (this.postgres.ready) {
      const rows = normalizeQueryRows(await this.postgres.query(
        `SELECT role, status, auth_version, must_change_password, deleted_at FROM users WHERE id = $1`,
        [id],
      ));
      const row = rows[0];
      if (!row) return undefined;
      return {
        role: String(row.role),
        status: String(row.status),
        authVersion: row.auth_version == null ? 1 : Number(row.auth_version),
        deleted: row.deleted_at != null,
        mustChangePassword: row.must_change_password === true,
      };
    }
    type MemoryUserRow = { role: string; status: string; authVersion?: number; mustChangePassword?: boolean } & import('../common/types/base').BaseRow;
    const acc = this.memory.findById<MemoryUserRow>('users', id);
    if (!acc) return undefined;
    return {
      role: acc.role,
      status: acc.status,
      authVersion: acc.authVersion ?? 1,
      deleted: acc.deletedAt != null,
      mustChangePassword: acc.mustChangePassword === true,
    };
  }
}
