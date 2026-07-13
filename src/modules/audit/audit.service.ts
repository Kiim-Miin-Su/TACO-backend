// [참조/처리] 범용 변경 이력(audit_log — TBO-16 #7, erd.dbml v8 §29) — "누가·언제·무엇을·어떻게".
//  - 기록 지점: schedule(세션 CRUD)·availability(가용/불가 upsert·삭제)·schedule-requests(승인/반려).
//    TBO-13에서 students/enrollments status_change 편입 예정(같은 테이블 — 이력 메커니즘 단일화).
//  - 호출 규약: **쓰기 서비스의 db.transaction 안에서** log()를 호출(이력 포함 원자성 — 롤백 시 이력도 롤백).
//  - delete는 changes에 before 전체 스냅샷('__row' 키 — 복원 근거), update는 변경 필드 diff만(diffOf).
//  - append-only: 본 컬렉션에는 update/remove를 제공하지 않는다(불변 — dbml v9 §32 예외 테이블).
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { AuditAction, AuditLog } from '@kms545487/contracts';
import { AUDIT_LOG_SPEC } from '../../database/calendar-asset-specs';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { PostgresCollectionStore } from '../../database/postgres-collection.store';

export const AUDIT_LOG = 'audit_log';

type AuditRow = AuditLog & BaseRow;

export type AuditEntry = {
  entity: string; // 'class_sessions' | 'schedule_requests' | 'availability_blocks' | ...
  entityId: number;
  action: AuditAction;
  actorId: number; // JWT sub
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  reason?: string;
};

@Injectable()
export class AuditService implements OnModuleInit {
  constructor(
    private readonly db: InMemoryDatabase,
    private readonly store: PostgresCollectionStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.hydrate<AuditRow>(AUDIT_LOG_SPEC);
  }

  /** 이력 1건 기록 — 호출자는 반드시 자신의 트랜잭션 안에서 호출(원자성). */
  async log(entry: AuditEntry): Promise<AuditRow> {
    return this.store.insert<AuditRow>(AUDIT_LOG_SPEC, {
      ...entry,
      at: new Date().toISOString(),
    } as Omit<AuditRow, keyof BaseRow>);
  }

  /** 변경 필드 diff — update 기록용(스냅샷 아님). audit 메타 필드는 제외. */
  diffOf(before: object, after: object): Record<string, { before?: unknown; after?: unknown }> {
    const skip = new Set(['updatedAt', 'createdAt', 'deletedAt', 'deletedBy']);
    const out: Record<string, { before?: unknown; after?: unknown }> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      if (skip.has(k)) continue;
      const b = (before as Record<string, unknown>)[k];
      const a = (after as Record<string, unknown>)[k];
      if (JSON.stringify(b) !== JSON.stringify(a)) out[k] = { before: b, after: a };
    }
    return out;
  }

  /** delete 기록용 — before 전체 스냅샷('__row' 키, 복원 근거). */
  snapshotOf(row: object): Record<string, { before?: unknown }> {
    return { __row: { before: { ...row } } };
  }

  /** 이력 조회(최신순) — ADMIN 전용(컨트롤러에서 게이트). entity/entityId/actorId 필터. */
  async list(q: { entity?: string; entityId?: number; actorId?: number; limit?: number }): Promise<AuditRow[]> {
    await this.store.hydrate<AuditRow>(AUDIT_LOG_SPEC);
    let rows = q.entity && q.entityId != null
      ? this.db.findBy<AuditRow>(AUDIT_LOG, (r) => r.entity === q.entity && r.entityId === q.entityId)
      : q.entity
        ? this.db.findByField<AuditRow>(AUDIT_LOG, 'entity', q.entity)
        : this.db.findAll<AuditRow>(AUDIT_LOG);
    if (q.actorId != null) rows = rows.filter((r) => r.actorId === q.actorId);
    return rows.sort((a, b) => b.id - a.id).slice(0, Math.min(q.limit ?? 200, 500));
  }
}
