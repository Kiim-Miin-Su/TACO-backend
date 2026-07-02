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
