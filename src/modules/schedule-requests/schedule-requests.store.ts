import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { PostgresConnectionService } from '../../database/postgres-connection.service';

const TABLE = 'schedule_requests';

const REQUEST_KINDS = ['session_create', 'session_update', 'session_delete', 'availability_upsert', 'availability_delete'];
const REQUEST_STATUSES = ['pending', 'approved', 'rejected'];
const RECURRENCE_SCOPES = ['this', 'this_and_following', 'all'];

type DbRow = Record<string, unknown>;

const camelToSnake = (key: string): string => key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const snakeToCamel = (key: string): string => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const sqlList = (items: string[]): string => items.map((x) => `'${x}'`).join(', ');

function parseJsonArray(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : undefined;
  } catch {
    return undefined;
  }
}

function toIso(value: unknown): string | null | undefined {
  if (value == null) return value as null | undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toDateString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

@Injectable()
export class ScheduleRequestsStore implements OnModuleInit {
  private readonly logger = new Logger(ScheduleRequestsStore.name);
  private schemaReady = false;
  private memoryTransactionTail: Promise<void> = Promise.resolve();
  private readonly memoryTransactionContext = new AsyncLocalStorage<boolean>();

  constructor(
    private readonly memory: InMemoryDatabase,
    private readonly postgres: PostgresConnectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.postgres.ensureInitialized();
    if (!this.postgres.ready) return;
    await this.ensureSchema();
  }

  get durable(): boolean {
    return this.postgres.ready && this.schemaReady;
  }

  async transaction<R>(fn: () => R | Promise<R>): Promise<R> {
    if (!this.durable) {
      if (this.memoryTransactionContext.getStore()) return this.memory.transaction(fn);
      const run = this.memoryTransactionTail.then(() =>
        this.memoryTransactionContext.run(true, () => this.memory.transaction(fn)),
      );
      this.memoryTransactionTail = run.then(() => undefined, () => undefined);
      return run;
    }
    return this.postgres.transaction(async () => fn());
  }

  async insert<T extends BaseRow>(data: Omit<T, keyof BaseRow>): Promise<T> {
    if (!this.durable) return this.memory.insert<T>(TABLE, data);
    const payload = this.toDbPayload(data as Record<string, unknown>);
    const keys = Object.keys(payload);
    const columns = keys.map(camelToSnake);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const values = keys.map((k) => payload[k]);
    const [row] = await this.query(
      `INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values,
    );
    return this.fromDbRow<T>(row);
  }

  async findAll<T extends BaseRow>(): Promise<T[]> {
    if (!this.durable) return this.memory.findAll<T>(TABLE);
    const rows = await this.query(`SELECT * FROM ${TABLE} WHERE deleted_at IS NULL ORDER BY id DESC`);
    return rows.map((r) => this.fromDbRow<T>(r));
  }

  async findByField<T extends BaseRow>(field: keyof T & string, value: unknown): Promise<T[]> {
    if (!this.durable) return this.memory.findByField<T>(TABLE, field, value);
    const column = camelToSnake(field);
    const rows = await this.query(`SELECT * FROM ${TABLE} WHERE deleted_at IS NULL AND ${column} = $1 ORDER BY id DESC`, [value]);
    return rows.map((r) => this.fromDbRow<T>(r));
  }

  async findById<T extends BaseRow>(id: number, options?: { forUpdate?: boolean }): Promise<T | undefined> {
    if (!this.durable) return this.memory.findById<T>(TABLE, id);
    const lock = options?.forUpdate ? ' FOR UPDATE' : '';
    const [row] = await this.query(`SELECT * FROM ${TABLE} WHERE id = $1 AND deleted_at IS NULL${lock}`, [id]);
    return row ? this.fromDbRow<T>(row) : undefined;
  }

  async update<T extends BaseRow>(id: number, patch: Partial<Omit<T, keyof BaseRow>>): Promise<T | undefined> {
    if (!this.durable) return this.memory.update<T>(TABLE, id, patch);
    const payload = this.toDbPayload(patch as Record<string, unknown>);
    const keys = Object.keys(payload);
    if (!keys.length) return this.findById<T>(id);
    const assignments = keys.map((key, i) => `${camelToSnake(key)} = $${i + 1}`);
    const values = keys.map((key) => payload[key]);
    values.push(id);
    const [row] = await this.query(
      `UPDATE ${TABLE} SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    return row ? this.fromDbRow<T>(row) : undefined;
  }

  async remove(id: number, deletedBy?: number): Promise<boolean> {
    if (!this.durable) return this.memory.remove(TABLE, id, deletedBy);
    const rows = await this.query(
      `UPDATE ${TABLE} SET deleted_at = now(), deleted_by = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL RETURNING id`,
      [deletedBy ?? null, id],
    );
    return rows.length > 0;
  }

  private async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id serial PRIMARY KEY,
        requester_id integer NOT NULL,
        request_kind varchar(32) NOT NULL DEFAULT 'session_create' CHECK (request_kind IN (${sqlList(REQUEST_KINDS)})),
        target_session_id integer,
        course_id integer,
        instructor_id integer,
        room_id integer,
        session_date date,
        start_time varchar(5),
        end_time varchar(5),
        duration_minutes integer,
        kind varchar(32) NOT NULL DEFAULT 'class',
        mode varchar(32) DEFAULT 'in_person',
        topic varchar(200),
        student_ids text NOT NULL DEFAULT '[]',
        request_reason text,
        scope varchar(32) DEFAULT 'this' CHECK (scope IS NULL OR scope IN (${sqlList(RECURRENCE_SCOPES)})),
        target_availability_id integer,
        availability_owner_type varchar(32),
        availability_owner_id integer,
        availability_kind varchar(32),
        availability_weekday integer,
        availability_start_time varchar(5),
        availability_end_time varchar(5),
        availability_effective_from date,
        availability_effective_to date,
        impact_session_ids text NOT NULL DEFAULT '[]',
        change_summary varchar(300),
        status varchar(32) NOT NULL DEFAULT 'pending' CHECK (status IN (${sqlList(REQUEST_STATUSES)})),
        reason varchar(200),
        decided_by integer,
        decided_at timestamptz,
        created_session_id integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        deleted_by integer
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_status ON ${TABLE} (status) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_requester_id ON ${TABLE} (requester_id) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_request_kind ON ${TABLE} (request_kind) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_target_session_id ON ${TABLE} (target_session_id) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_decided_by ON ${TABLE} (decided_by) WHERE deleted_at IS NULL`);
    this.schemaReady = true;
    this.logger.log('schedule_requests table ready (Postgres-backed)');
  }

  private async query(sql: string, params: unknown[] = []): Promise<DbRow[]> {
    const result = await this.postgres.query(sql, params);
    if (Array.isArray(result) && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[0] as DbRow[];
    }
    return result as DbRow[];
  }

  private toDbPayload(src: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined) continue;
      if (key === 'studentIds' || key === 'impactSessionIds') {
        out[key] = JSON.stringify(Array.isArray(value) ? value : []);
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private fromDbRow<T extends BaseRow>(row: DbRow): T {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[snakeToCamel(key)] = value;
    out.studentIds = parseJsonArray(row.student_ids) ?? [];
    out.impactSessionIds = parseJsonArray(row.impact_session_ids) ?? [];
    out.sessionDate = toDateString(row.session_date);
    out.availabilityEffectiveFrom = toDateString(row.availability_effective_from);
    out.availabilityEffectiveTo = toDateString(row.availability_effective_to);
    out.createdAt = toIso(row.created_at);
    out.updatedAt = toIso(row.updated_at);
    out.deletedAt = toIso(row.deleted_at);
    out.decidedAt = toIso(row.decided_at);
    return out as T;
  }
}
