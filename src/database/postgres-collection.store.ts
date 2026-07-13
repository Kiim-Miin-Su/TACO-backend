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

export type PostgresCollectionSpec = {
  table: string;
  createSql: string;
  indexes?: string[];
  jsonFields?: string[];
  dateFields?: string[];
  timestampFields?: string[];
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
    await this.query(spec.createSql);
    for (const indexSql of spec.indexes ?? []) await this.query(indexSql);
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

  async seed<T extends BaseRow>(spec: PostgresCollectionSpec, rows: Array<Omit<T, keyof BaseRow> & { id: number }>): Promise<T[]> {
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
