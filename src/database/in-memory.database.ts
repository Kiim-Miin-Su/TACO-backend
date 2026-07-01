// [참조/처리] 전역 인메모리 저장소(단일 인스턴스, DatabaseModule이 provide).
//  - 모든 도메인 서비스(students/schedule/payouts/events…)가 생성자에서 InMemoryDatabase를 DI로 주입받아
//    이 한 곳의 컬렉션(collection name 상수 키)에 read/write. → 사실상의 "DB".
//  - seed<T>(name, rows): 고정 id로 멱등 삽입(재기동/하이드레이션 중복 방지, audit 필드 자동).
//    insert<T>: nextId 자동 부여. 참조 무결성(FK 정합)은 각 서비스가 seed 단계에서 id를 맞춰 보장.
//  - 프론트는 이 데이터를 REST로 받아 zustand store에 하이드레이트(단일 소스).
import { Injectable } from '@nestjs/common';
import { BaseRow } from '../common/types/base';

export type { BaseRow };

/**
 * 아주 단순한 in-memory 저장소.
 * 추후 PostgreSQL(TypeORM)로 교체할 때, 이 인터페이스를 Repository로 갈아끼우면 됩니다.
 */
@Injectable()
export class InMemoryDatabase {
  private store = new Map<string, BaseRow[]>();
  private sequences = new Map<string, number>();

  private collection<T extends BaseRow>(name: string): T[] {
    if (!this.store.has(name)) this.store.set(name, []);
    return this.store.get(name) as T[];
  }

  private nextId(name: string): number {
    const next = (this.sequences.get(name) ?? 0) + 1;
    this.sequences.set(name, next);
    return next;
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
      if (coll.some((x) => x.id === r.id)) continue;
      const row = { ...(r as object), createdAt: now, updatedAt: now } as T;
      coll.push(row);
      inserted.push(row);
      if (r.id > (this.sequences.get(name) ?? 0)) this.sequences.set(name, r.id);
    }
    return inserted;
  }

  findById<T extends BaseRow>(name: string, id: number): T | undefined {
    return this.collection<T>(name).find((r) => r.id === id);
  }

  findBy<T extends BaseRow>(name: string, predicate: (row: T) => boolean): T[] {
    return this.collection<T>(name).filter(predicate);
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
    return row;
  }

  update<T extends BaseRow>(
    name: string,
    id: number,
    patch: Partial<Omit<T, keyof BaseRow>>,
  ): T | undefined {
    const row = this.findById<T>(name, id);
    if (!row) return undefined;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    return row;
  }

  remove(name: string, id: number): boolean {
    const rows = this.collection(name);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return false;
    rows.splice(i, 1);
    return true;
  }
}
