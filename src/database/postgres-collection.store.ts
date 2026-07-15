import { Injectable, Logger } from '@nestjs/common';
import type { BaseRow } from '../common/types/base';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresConnectionService } from './postgres-connection.service';
import {
  camelToSnake,
  normalizeQueryRows,
  parseJson,
  snakeToCamel,
  toDateString,
  toIsoString,
  type PostgresRow,
} from './postgres-row.util';
import { demoSeedEnabled } from '../config/demo-seed';

export type PostgresCollectionSpec = {
  table: string;
  createSql: string;
  /** [TBO-28B] 멱등 스키마 마이그레이션(ALTER TABLE … ADD COLUMN IF NOT EXISTS 등).
   *  기존 테이블엔 createSql(CREATE TABLE IF NOT EXISTS)이 no-op이므로 신규 컬럼은 여기로만 도달한다.
   *  실행 순서: createSql → migrations → indexes. */
  migrations?: string[];
  indexes?: string[];
  jsonFields?: string[];
  dateFields?: string[];
  timestampFields?: string[];
};

export type ActiveFindOptions<T extends BaseRow> = {
  where?: Partial<Record<keyof T & string, unknown>>;
  orderBy?: { field: keyof T & string; direction?: 'ASC' | 'DESC' };
  limit?: number;
};

const safeColumn = (field: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) throw new Error(`Unsafe query field: ${field}`);
  return camelToSnake(field);
};

@Injectable()
export class PostgresCollectionStore {
  private readonly logger = new Logger(PostgresCollectionStore.name);
  private readonly readyTables = new Set<string>();

  constructor(
    private readonly memory: InMemoryDatabase,
    private readonly postgres: PostgresConnectionService,
  ) {}

  async ensureReady(spec: PostgresCollectionSpec): Promise<boolean> {
    await this.postgres.ensureInitialized();
    if (!this.postgres.ready) return false;
    if (this.readyTables.has(spec.table)) return true;
    // [TBO-28B] DDL은 postgres.ddl(직렬화+중복 무해)로 — 부팅 병렬 onModuleInit 레이스 차단.
    await this.postgres.ddl(spec.createSql);
    for (const migrationSql of spec.migrations ?? []) await this.postgres.ddl(migrationSql);
    for (const indexSql of spec.indexes ?? []) await this.postgres.ddl(indexSql);
    this.readyTables.add(spec.table);
    this.logger.log(`${spec.table} table ready (Postgres-backed)`);
    return true;
  }

  async hydrate<T extends BaseRow>(spec: PostgresCollectionSpec): Promise<T[]> {
    if (!(await this.ensureReady(spec))) return [];
    const rows = await this.query(`SELECT * FROM ${spec.table} ORDER BY id ASC`);
    const parsed = rows.map((row) => this.fromDbRow<T>(spec, row));
    this.memory.replaceExact<T>(spec.table, parsed);
    return parsed;
  }

  async findActive<T extends BaseRow>(spec: PostgresCollectionSpec, options: ActiveFindOptions<T> = {}): Promise<T[]> {
    const where = Object.entries(options.where ?? {}).filter(([, value]) => value !== undefined);
    const direction = options.orderBy?.direction ?? 'ASC';
    const limit = options.limit == null ? undefined : Math.max(0, Math.floor(options.limit));
    if (!(await this.ensureReady(spec))) {
      let rows = this.memory.findAll<T>(spec.table).filter((row) =>
        where.every(([field, value]) => (row as Record<string, unknown>)[field] === value),
      );
      if (options.orderBy) {
        const field = options.orderBy.field;
        rows = rows.sort((a, b) => {
          const left = (a as Record<string, unknown>)[field];
          const right = (b as Record<string, unknown>)[field];
          const compared = left === right ? 0 : left == null ? -1 : right == null ? 1 : left < right ? -1 : 1;
          return direction === 'DESC' ? -compared : compared;
        });
      }
      return limit == null ? rows : rows.slice(0, limit);
    }

    const values = where.map(([, value]) => value);
    const conditions = where.map(([field], index) => `${safeColumn(field)} = $${index + 1}`);
    const order = options.orderBy ? ` ORDER BY ${safeColumn(options.orderBy.field)} ${direction}` : '';
    const limitSql = limit == null ? '' : ` LIMIT ${limit}`;
    const rows = await this.query(
      `SELECT * FROM ${spec.table} WHERE deleted_at IS NULL${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}${order}${limitSql}`,
      values,
    );
    return rows.map((row) => this.fromDbRow<T>(spec, row));
  }

  async seed<T extends BaseRow>(spec: PostgresCollectionSpec, rows: Array<Omit<T, keyof BaseRow> & { id: number }>): Promise<T[]> {
    if (!demoSeedEnabled()) return []; // [시범운영] 데모 시드 단일 관문 — production 기본 차단
    if (!(await this.ensureReady(spec))) return this.memory.seed<T>(spec.table, rows);
    const saved: T[] = [];
    for (const row of rows) {
      const [created] = await this.insertDb<T>(spec, row as Record<string, unknown>, true);
      if (created) saved.push(created);
    }
    await this.syncSequence(spec.table);
    this.memory.seedExact<T>(spec.table, saved);
    return saved;
  }

  async insert<T extends BaseRow>(spec: PostgresCollectionSpec, data: Omit<T, keyof BaseRow>): Promise<T> {
    if (!(await this.ensureReady(spec))) return this.memory.insert<T>(spec.table, data);
    const [saved] = await this.insertDb<T>(spec, data as Record<string, unknown>, false);
    if (!saved) throw new Error(`${spec.table} insert did not return a row`);
    this.memory.seedExact<T>(spec.table, [saved]);
    return saved;
  }

  async update<T extends BaseRow>(spec: PostgresCollectionSpec, id: number, patch: Partial<Omit<T, keyof BaseRow>>): Promise<T | undefined> {
    if (!(await this.ensureReady(spec))) return this.memory.update<T>(spec.table, id, patch);
    const payload = this.toDbPayload(spec, patch as Record<string, unknown>);
    const keys = Object.keys(payload);
    if (!keys.length) return this.memory.findById<T>(spec.table, id);
    const assignments = keys.map((key, i) => `${camelToSnake(key)} = $${i + 1}`);
    const values = keys.map((key) => payload[key]);
    values.push(id);
    const [row] = await this.query(
      `UPDATE ${spec.table} SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!row) return undefined;
    const saved = this.fromDbRow<T>(spec, row);
    this.memory.update<T>(spec.table, id, this.withoutBase(saved));
    return this.memory.findById<T>(spec.table, id) ?? saved;
  }

  async remove(spec: PostgresCollectionSpec, id: number, deletedBy?: number): Promise<boolean> {
    if (!(await this.ensureReady(spec))) return this.memory.remove(spec.table, id, deletedBy);
    const rows = await this.query(
      `UPDATE ${spec.table} SET deleted_at = now(), deleted_by = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL RETURNING id`,
      [deletedBy ?? null, id],
    );
    if (!rows.length) return false;
    return this.memory.remove(spec.table, id, deletedBy);
  }

  async removeByField(spec: PostgresCollectionSpec, field: string, value: unknown, deletedBy?: number): Promise<number> {
    if (!(await this.ensureReady(spec))) {
      const rows = this.memory.findByField<BaseRow>(spec.table, field as keyof BaseRow & string, value);
      return rows.reduce((count, row) => count + (this.memory.remove(spec.table, row.id, deletedBy) ? 1 : 0), 0);
    }
    const rows = await this.query(
      `UPDATE ${spec.table} SET deleted_at = now(), deleted_by = $1, updated_at = now()
        WHERE ${camelToSnake(field)} = $2 AND deleted_at IS NULL RETURNING id`,
      [deletedBy ?? null, value],
    );
    for (const row of rows) this.memory.remove(spec.table, Number(row.id), deletedBy);
    return rows.length;
  }

  async updateIf<T extends BaseRow>(
    spec: PostgresCollectionSpec,
    id: number,
    expected: Partial<Omit<T, keyof BaseRow>>,
    patch: Partial<Omit<T, keyof BaseRow>>,
  ): Promise<T | undefined> {
    if (!(await this.ensureReady(spec))) {
      const current = this.memory.findById<T>(spec.table, id);
      if (!current || Object.entries(expected).some(([key, value]) => (current as Record<string, unknown>)[key] !== value)) return undefined;
      return this.memory.update<T>(spec.table, id, patch);
    }
    const payload = this.toDbPayload(spec, patch as Record<string, unknown>);
    const expectedPayload = this.toDbPayload(spec, expected as Record<string, unknown>);
    const patchKeys = Object.keys(payload);
    const expectedKeys = Object.keys(expectedPayload);
    if (!patchKeys.length) return this.memory.findById<T>(spec.table, id);
    const values = patchKeys.map((key) => payload[key]);
    const assignments = patchKeys.map((key, index) => `${camelToSnake(key)} = $${index + 1}`);
    values.push(id);
    const idParam = values.length;
    const conditions = expectedKeys.map((key) => {
      values.push(expectedPayload[key]);
      return `${camelToSnake(key)} = $${values.length}`;
    });
    const [row] = await this.query(
      `UPDATE ${spec.table} SET ${assignments.join(', ')}, updated_at = now()
        WHERE id = $${idParam} AND deleted_at IS NULL${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}
        RETURNING *`,
      values,
    );
    if (!row) return undefined;
    const saved = this.fromDbRow<T>(spec, row);
    this.memory.update<T>(spec.table, id, this.withoutBase(saved));
    return this.memory.findById<T>(spec.table, id) ?? saved;
  }

  private async insertDb<T extends BaseRow>(
    spec: PostgresCollectionSpec,
    data: Record<string, unknown>,
    withId: boolean,
  ): Promise<T[]> {
    const payload = this.toDbPayload(spec, data);
    if (!withId) delete payload.id;
    const keys = Object.keys(payload);
    const columns = keys.map(camelToSnake);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const updates = columns
      .filter((c) => c !== 'id')
      .map((c) => `${c} = EXCLUDED.${c}`);
    const values = keys.map((key) => payload[key]);
    const conflict = withId && updates.length
      ? ` ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}, updated_at = now()`
      : withId
        ? ' ON CONFLICT (id) DO NOTHING'
        : '';
    const rows = await this.query(
      `INSERT INTO ${spec.table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${conflict} RETURNING *`,
      values,
    );
    return rows.map((row) => this.fromDbRow<T>(spec, row));
  }

  private async syncSequence(table: string): Promise<void> {
    await this.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`);
  }

  private async query(sql: string, params: unknown[] = []): Promise<PostgresRow[]> {
    const result = await this.postgres.query(sql, params);
    return normalizeQueryRows(result);
  }

  private toDbPayload(spec: PostgresCollectionSpec, src: Record<string, unknown>): Record<string, unknown> {
    const jsonFields = new Set(spec.jsonFields ?? []);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined) continue;
      out[key] = jsonFields.has(key) ? JSON.stringify(value ?? []) : value;
    }
    return out;
  }

  private fromDbRow<T extends BaseRow>(spec: PostgresCollectionSpec, row: PostgresRow): T {
    const out: Record<string, unknown> = {};
    const jsonFields = new Set(spec.jsonFields ?? []);
    const dateFields = new Set(spec.dateFields ?? []);
    for (const [key, value] of Object.entries(row)) {
      const camel = snakeToCamel(key);
      if (jsonFields.has(camel)) out[camel] = parseJson(value);
      else if (dateFields.has(camel)) out[camel] = toDateString(value);
      else if (camel === 'createdAt' || camel === 'updatedAt' || camel === 'deletedAt' || (spec.timestampFields ?? []).includes(camel)) out[camel] = toIsoString(value);
      else out[camel] = value;
    }
    return out as T;
  }

  private withoutBase<T extends BaseRow>(row: T): Partial<Omit<T, keyof BaseRow>> {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, deletedBy: _deletedBy, ...rest } = row;
    return rest as Partial<Omit<T, keyof BaseRow>>;
  }
}
