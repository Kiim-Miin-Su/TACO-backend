// [TBO-28C 2026-07-14] 캘린더 쓰기 명령의 단일 경계.
//  · run(fn): 메모리 스냅샷(전역 FIFO 직렬화 — in-memory.database) ⊃ Postgres tx. 중첩은 양쪽 다 passthrough.
//  · lockTargets(keys): tx 안에서 pg_advisory_xact_lock을 **결정적 (kind,id) 정렬 순서**로 획득 —
//    서로 다른 요청/인스턴스가 같은 강사·강의실·학생·세션을 동시에 예약하지 못하게 직렬화(deadlock-free).
//    xact lock은 commit/rollback 시 자동 해제라 Neon pooled(pgbouncer transaction mode)에서 안전.
//    in-memory 모드는 no-op(메모리 tx 전역 큐가 이미 직렬화).
//  정책 근거: TBO-28A-BASELINE §3 (SERIALIZABLE+40001 재시도 기각 사유 포함).
import { Injectable } from '@nestjs/common';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresConnectionService } from './postgres-connection.service';

// advisory lock 키 공간 — (classid=자원 종류, objid=자원 id)
export const LOCK_KIND = {
  instructor: 1,
  room: 2,
  student: 3,
  session: 4,
} as const;

export type CalendarLockKey = { kind: keyof typeof LOCK_KIND; id: number };

@Injectable()
export class CalendarUnitOfWork {
  constructor(
    private readonly postgres: PostgresConnectionService,
    private readonly memory: InMemoryDatabase,
  ) {}

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.memory.transaction(() => this.postgres.transaction(async () => fn()));
  }

  /** 반드시 run(=pg tx) 안에서 호출. 키를 정렬·중복 제거 후 순서대로 잠근다. */
  async lockTargets(keys: CalendarLockKey[]): Promise<void> {
    if (!this.postgres.ready || !keys.length) return;
    const uniq = new Map<string, { classid: number; objid: number }>();
    for (const k of keys) {
      if (k.id == null || !Number.isFinite(Number(k.id))) continue;
      const classid = LOCK_KIND[k.kind];
      const objid = Number(k.id);
      uniq.set(`${classid}:${objid}`, { classid, objid });
    }
    const ordered = [...uniq.values()].sort((a, b) => a.classid - b.classid || a.objid - b.objid);
    for (const { classid, objid } of ordered) {
      await this.postgres.query('SELECT pg_advisory_xact_lock($1, $2)', [classid, objid]);
    }
  }
}
