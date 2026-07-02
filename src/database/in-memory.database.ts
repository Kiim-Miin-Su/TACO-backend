// [참조/처리] 전역 인메모리 저장소(단일 인스턴스, DatabaseModule이 provide) — **단일 진실원**.
//  - 모든 도메인 서비스(students/schedule/payouts/events…)가 생성자에서 InMemoryDatabase를 DI로 주입받아
//    이 한 곳의 컬렉션(collection name 상수 키)에 read/write. → 사실상의 "DB".
//  - seed<T>(name, rows): 고정 id로 멱등 삽입(재기동/하이드레이션 중복 방지, audit 필드 자동).
//    insert<T>: nextId 자동 부여. 참조 무결성(FK 정합)은 각 서비스가 seed 단계에서 id를 맞춰 보장.
//
//  [최적화 2026-07-02]
//  ① transaction(fn): 다중 쓰기의 **원자성** — fn 안에서 예외가 나면 전체 store·시퀀스·인덱스를
//     스냅샷으로 롤백(부분 쓰기 잔존 금지). 중첩 호출은 최외곽 경계만 스냅샷(nested no-op).
//     ⚠ 롤백 시 행 객체가 스냅샷 사본으로 교체되므로, 트랜잭션 밖에서 행 참조를 보관하지 말 것
//       (현 서비스들은 요청 스코프에서 조회→반환만 하므로 안전).
//  ② findById: id 인덱스(Map)로 O(1).
//  ③ findByField: 세컨더리 인덱스(lazy 생성·자동 유지) — FK 핫패스(enrollments.courseId,
//     attendance.sessionId, session_reports.sessionId 등)의 전체 스캔 제거.
//     인덱스 계획은 docs/erd.dbml의 각 테이블 indexes 블록과 1:1(TBO-08 Postgres 이관 시 그대로 생성).
import { Injectable } from '@nestjs/common';
import { BaseRow } from '../common/types/base';

export type { BaseRow };

/**
 * 아주 단순한 in-memory 저장소.
 * 추후 PostgreSQL(TypeORM)로 교체할 때, 이 인터페이스를 Repository로 갈아끼우면 됩니다.
 * (transaction ↔ DB 트랜잭션, findByField ↔ 인덱스 조회로 1:1 대응되도록 설계)
 */
@Injectable()
export class InMemoryDatabase {
  private store = new Map<string, BaseRow[]>();
  private sequences = new Map<string, number>();
  // id 인덱스: collection → (id → row)
  private idIndex = new Map<string, Map<number, BaseRow>>();
  // 세컨더리 인덱스: collection → field → (value → rows). findByField 최초 호출 시 lazy 백필.
  private fieldIndex = new Map<string, Map<string, Map<unknown, Set<BaseRow>>>>();
  // 트랜잭션 중첩 깊이(최외곽만 스냅샷/롤백)
  private txDepth = 0;

  private collection<T extends BaseRow>(name: string): T[] {
    if (!this.store.has(name)) this.store.set(name, []);
    return this.store.get(name) as T[];
  }

  private ids(name: string): Map<number, BaseRow> {
    if (!this.idIndex.has(name)) this.idIndex.set(name, new Map());
    return this.idIndex.get(name)!;
  }

  private nextId(name: string): number {
    const next = (this.sequences.get(name) ?? 0) + 1;
    this.sequences.set(name, next);
    return next;
  }

  // ── 인덱스 유지 훅 ──
  private indexAdd(name: string, row: BaseRow): void {
    this.ids(name).set(row.id, row);
    const fields = this.fieldIndex.get(name);
    if (!fields) return;
    for (const [field, buckets] of fields) {
      const v = (row as Record<string, unknown>)[field];
      if (!buckets.has(v)) buckets.set(v, new Set());
      buckets.get(v)!.add(row);
    }
  }

  private indexRemove(name: string, row: BaseRow): void {
    this.ids(name).delete(row.id);
    const fields = this.fieldIndex.get(name);
    if (!fields) return;
    for (const [field, buckets] of fields) {
      const v = (row as Record<string, unknown>)[field];
      buckets.get(v)?.delete(row);
    }
  }

  /** update로 인덱스 대상 필드가 바뀔 때 버킷 이동(값 변화 전 호출 → patch 적용 → 재등록). */
  private reindexForPatch(name: string, row: BaseRow, patch: object): void {
    const fields = this.fieldIndex.get(name);
    if (!fields) return;
    for (const [field, buckets] of fields) {
      if (!(field in (patch as Record<string, unknown>))) continue;
      const oldV = (row as Record<string, unknown>)[field];
      buckets.get(oldV)?.delete(row);
      const newV = (patch as Record<string, unknown>)[field];
      if (!buckets.has(newV)) buckets.set(newV, new Set());
      buckets.get(newV)!.add(row);
    }
  }

  /** 컬렉션 전체를 다시 인덱싱(트랜잭션 롤백 후 복구용). */
  private rebuildIndexes(): void {
    this.idIndex = new Map();
    const registered = new Map<string, string[]>();
    for (const [name, fields] of this.fieldIndex) registered.set(name, [...fields.keys()]);
    this.fieldIndex = new Map();
    for (const [name, rows] of this.store) {
      for (const row of rows) this.ids(name).set(row.id, row);
      for (const field of registered.get(name) ?? []) this.ensureFieldIndex(name, field);
    }
  }

  private ensureFieldIndex(name: string, field: string): Map<unknown, Set<BaseRow>> {
    if (!this.fieldIndex.has(name)) this.fieldIndex.set(name, new Map());
    const fields = this.fieldIndex.get(name)!;
    if (!fields.has(field)) {
      const buckets = new Map<unknown, Set<BaseRow>>();
      for (const row of this.collection(name)) {
        const v = (row as Record<string, unknown>)[field];
        if (!buckets.has(v)) buckets.set(v, new Set());
        buckets.get(v)!.add(row);
      }
      fields.set(field, buckets);
    }
    return fields.get(field)!;
  }

  // ── 트랜잭션: 다중 쓰기의 원자성(전부 반영 or 전부 롤백) ──
  transaction<R>(fn: () => R): R {
    if (this.txDepth > 0) {
      // 중첩: 외곽 트랜잭션의 스냅샷이 이미 전체를 보호 — 그대로 실행.
      this.txDepth++;
      try { return fn(); } finally { this.txDepth--; }
    }
    // 스냅샷(깊은 복사) — 행 mutate(update)까지 원복 가능해야 하므로 structuredClone.
    const storeSnap = structuredClone(this.store);
    const seqSnap = new Map(this.sequences);
    this.txDepth = 1;
    try {
      return fn();
    } catch (e) {
      this.store = storeSnap;
      this.sequences = seqSnap;
      this.rebuildIndexes(); // 스냅샷 행 객체 기준으로 인덱스 재구성
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  findAll<T extends BaseRow>(name: string): T[] {
    return [...this.collection<T>(name)];
  }

  /**
   * 명시적 id로 시드 삽입(데모 카탈로그용). 시퀀스를 max(id)까지 끌어올려
   * 이후 insert가 시드 id와 충돌하지 않게 한다. 같은 id가 이미 있으면 건너뜀.
   * 용도: courses/subjects 처럼 다른 컬렉션(class_sessions.courseId)이
   *       FK로 참조하는 카탈로그를 고정 id로 심어 조인 무결성을 보장.
   */
  seed<T extends BaseRow>(name: string, rows: Array<Omit<T, keyof BaseRow> & { id: number }>): T[] {
    const coll = this.collection<T>(name);
    const now = new Date().toISOString();
    const inserted: T[] = [];
    for (const r of rows) {
      if (this.ids(name).has(r.id) || coll.some((x) => x.id === r.id)) continue;
      const row = { ...(r as object), createdAt: now, updatedAt: now } as T;
      coll.push(row);
      this.indexAdd(name, row);
      inserted.push(row);
      if (r.id > (this.sequences.get(name) ?? 0)) this.sequences.set(name, r.id);
    }
    return inserted;
  }

  /** id 조회 — 인덱스로 O(1). */
  findById<T extends BaseRow>(name: string, id: number): T | undefined {
    const hit = this.ids(name).get(id) as T | undefined;
    if (hit) return hit;
    // 인덱스 미스 방어(직접 배열 조작 등 예외 상황) — 스캔 폴백 후 자가 치유
    const row = this.collection<T>(name).find((r) => r.id === id);
    if (row) this.ids(name).set(id, row);
    return row;
  }

  findBy<T extends BaseRow>(name: string, predicate: (row: T) => boolean): T[] {
    return this.collection<T>(name).filter(predicate);
  }

  /**
   * 단일 필드 동등 조회 — 세컨더리 인덱스(lazy 생성·자동 유지)로 전체 스캔 제거.
   * FK 핫패스 용: enrollments.courseId / attendance.sessionId / session_reports.sessionId 등.
   * (docs/erd.dbml 각 테이블 indexes 블록과 1:1 — TBO-08 이관 시 실제 DB 인덱스로)
   */
  findByField<T extends BaseRow>(name: string, field: keyof T & string, value: unknown): T[] {
    const buckets = this.ensureFieldIndex(name, field);
    return [...((buckets.get(value) as Set<T> | undefined) ?? [])];
  }

  insert<T extends BaseRow>(name: string, data: Omit<T, keyof BaseRow>): T {
    const now = new Date().toISOString();
    const row = {
      ...(data as object),
      id: this.nextId(name),
      createdAt: now,
      updatedAt: now,
    } as T;
    this.collection<T>(name).push(row);
    this.indexAdd(name, row);
    return row;
  }

  update<T extends BaseRow>(
    name: string,
    id: number,
    patch: Partial<Omit<T, keyof BaseRow>>,
  ): T | undefined {
    const row = this.findById<T>(name, id);
    if (!row) return undefined;
    this.reindexForPatch(name, row, patch); // 인덱스 대상 필드 버킷 이동
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return row;
  }

  remove(name: string, id: number): boolean {
    const rows = this.collection(name);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.indexRemove(name, rows[i]);
    rows.splice(i, 1);
    return true;
  }
}
