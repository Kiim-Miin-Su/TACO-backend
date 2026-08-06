import { TimedModuleInit } from '../../common/performance-timing';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { PostgresConnectionService } from '../../database/postgres-connection.service';
import {
  camelToSnake,
  normalizeQueryRows,
  parseJsonNumberArray,
  snakeToCamel,
  toDateString,
  toIsoString,
  type PostgresRow,
} from '../../database/postgres-row.util';
import { SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_RUNTIME_SQL } from '../../database/migrations/schedule-request-attendance-correction.migration';

const TABLE = 'schedule_requests';

const REQUEST_KINDS = ['session_create', 'session_update', 'session_delete', 'availability_upsert', 'availability_delete', 'instructor_attendance_correction'];
const REQUEST_STATUSES = ['pending', 'approved', 'rejected'];
const RECURRENCE_SCOPES = ['this', 'this_and_following', 'all'];

const sqlList = (items: string[]): string => items.map((x) => `'${x}'`).join(', ');

@TimedModuleInit()
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
    return this.memory.transaction(() => this.postgres.transaction(async () => fn()));
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

  async findByFilters<T extends BaseRow>(filters: { status?: string; requesterId?: number }): Promise<T[]> {
    if (!this.durable) {
      return this.memory.findAll<T>(TABLE)
        .filter((row) => filters.status == null || (row as Record<string, unknown>).status === filters.status)
        .filter((row) => filters.requesterId == null || (row as Record<string, unknown>).requesterId === filters.requesterId)
        .sort((a, b) => b.id - a.id);
    }
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (filters.status != null) {
      values.push(filters.status);
      conditions.push(`status = $${values.length}`);
    }
    if (filters.requesterId != null) {
      values.push(filters.requesterId);
      conditions.push(`requester_id = $${values.length}`);
    }
    const rows = await this.query(
      `SELECT * FROM ${TABLE} WHERE deleted_at IS NULL${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''} ORDER BY id DESC`,
      values,
    );
    return rows.map((row) => this.fromDbRow<T>(row));
  }

  async findByField<T extends BaseRow>(field: keyof T & string, value: unknown): Promise<T[]> {
    if (!this.durable) return this.memory.findByField<T>(TABLE, field, value);
    const column = camelToSnake(field);
    const rows = await this.query(`SELECT * FROM ${TABLE} WHERE deleted_at IS NULL AND ${column} = $1 ORDER BY id DESC`, [value]);
    return rows.map((r) => this.fromDbRow<T>(r));
  }

  async findPendingAttendanceCorrection<T extends BaseRow>(
    requesterId: number,
    targetSessionId: number,
  ): Promise<T | undefined> {
    if (!this.durable) {
      return this.memory.findAll<T>(TABLE).find((row) => {
        const value = row as Record<string, unknown>;
        return value.requestKind === 'instructor_attendance_correction'
          && value.status === 'pending'
          && Number(value.requesterId) === requesterId
          && Number(value.targetSessionId) === targetSessionId;
      });
    }
    const [row] = await this.query(
      `SELECT * FROM ${TABLE}
        WHERE requester_id=$1 AND target_session_id=$2
          AND request_kind='instructor_attendance_correction'
          AND status='pending' AND deleted_at IS NULL
        LIMIT 1`,
      [requesterId, targetSessionId],
    );
    return row ? this.fromDbRow<T>(row) : undefined;
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
    await this.postgres.ddl(`
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
        memo text,
        student_ids text NOT NULL DEFAULT '[]',
        request_reason text,
        instructor_attendance_before varchar(32),
        requested_instructor_attendance varchar(32),
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
        batch_key uuid,
        batch_fingerprint varchar(64),
        batch_index integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        deleted_by integer,
        CONSTRAINT c_schedule_requests_batch_complete CHECK (
          (batch_key IS NULL AND batch_fingerprint IS NULL AND batch_index IS NULL)
          OR (
            batch_key IS NOT NULL
            AND batch_fingerprint IS NOT NULL
            AND batch_fingerprint ~ '^[a-f0-9]{64}$'
            AND batch_index IS NOT NULL
            AND batch_index >= 0
          )
        )
      )
    `);
    for (const sql of SCHEDULE_REQUEST_ATTENDANCE_CORRECTION_RUNTIME_SQL) {
      await this.postgres.ddl(sql);
    }
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_status ON ${TABLE} (status) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_requester_id ON ${TABLE} (requester_id) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_request_kind ON ${TABLE} (request_kind) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_target_session_id ON ${TABLE} (target_session_id) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_decided_by ON ${TABLE} (decided_by) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_pending_kind_created ON ${TABLE} (status, request_kind, created_at DESC) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_requester_status_created ON ${TABLE} (requester_id, status, created_at DESC) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_target_availability_id ON ${TABLE} (target_availability_id) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_created_session_id ON ${TABLE} (created_session_id) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_status_id ON ${TABLE} (status, id DESC) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_requester_id_desc ON ${TABLE} (requester_id, id DESC) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE INDEX IF NOT EXISTS idx_schedule_requests_requester_status_id ON ${TABLE} (requester_id, status, id DESC) WHERE deleted_at IS NULL`);
    await this.postgres.ddl(`CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_requests_batch_item ON ${TABLE} (requester_id, batch_key, batch_index) WHERE batch_key IS NOT NULL`);
    this.schemaReady = true;
    this.logger.log('schedule_requests table ready (Postgres-backed)');
  }

  private async query(sql: string, params: unknown[] = []): Promise<PostgresRow[]> {
    const result = await this.postgres.query(sql, params);
    return normalizeQueryRows(result);
  }

  async lockBatch(requesterId: number, batchKey: string): Promise<void> {
    if (!this.durable) return;
    await this.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [requesterId, batchKey]);
  }

  async findBatch<T extends BaseRow & { batchIndex?: number }>(
    requesterId: number,
    batchKey: string,
  ): Promise<T[]> {
    if (!this.durable) {
      return this.memory.findAll<T>(TABLE, { withDeleted: true })
        .filter((row) => Number((row as Record<string, unknown>).requesterId) === requesterId)
        .filter((row) => (row as Record<string, unknown>).batchKey === batchKey)
        .sort((left, right) => Number(left.batchIndex ?? 0) - Number(right.batchIndex ?? 0));
    }
    const rows = await this.query(
      `SELECT * FROM ${TABLE}
        WHERE requester_id = $1 AND batch_key = $2
        ORDER BY batch_index ASC`,
      [requesterId, batchKey],
    );
    return rows.map((row) => this.fromDbRow<T>(row));
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

  private fromDbRow<T extends BaseRow>(row: PostgresRow): T {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[snakeToCamel(key)] = value;
    out.studentIds = parseJsonNumberArray(row.student_ids) ?? [];
    out.impactSessionIds = parseJsonNumberArray(row.impact_session_ids) ?? [];
    out.sessionDate = toDateString(row.session_date);
    out.availabilityEffectiveFrom = toDateString(row.availability_effective_from);
    out.availabilityEffectiveTo = toDateString(row.availability_effective_to);
    out.createdAt = toIsoString(row.created_at);
    out.updatedAt = toIsoString(row.updated_at);
    out.deletedAt = toIsoString(row.deleted_at);
    out.decidedAt = toIsoString(row.decided_at);
    return out as T;
  }
}
