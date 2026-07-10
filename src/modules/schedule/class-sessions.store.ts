import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InMemoryDatabase, type BaseRow } from '../../database/in-memory.database';
import { PostgresConnectionService } from '../../database/postgres-connection.service';
import { ClassSession, SESSIONS } from './schedule.entity';

const TABLE = SESSIONS;

const SESSION_STATUSES = ['scheduled', 'held', 'canceled', 'no_show', 'makeup'];
const SESSION_KINDS = ['class', 'level_test', 'counsel'];
const SESSION_MODES = ['in_person', 'online'];
const INSTRUCTOR_ATTENDANCE = ['present', 'late', 'absent', 'makeup'];

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
export class ClassSessionsStore implements OnModuleInit {
  private readonly logger = new Logger(ClassSessionsStore.name);
  private ready = false;
  private hydrated = false;

  constructor(
    private readonly memory: InMemoryDatabase,
    private readonly postgres: PostgresConnectionService,
  ) {}

  get durable(): boolean {
    return this.postgres.ready && this.ready;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureReady();
  }

  async ensureReady(): Promise<void> {
    await this.postgres.ensureInitialized();
    if (!this.postgres.ready) return;
    if (!this.ready) await this.ensureSchema();
    if (!this.hydrated) await this.hydrateMemory();
  }

  async seed(rows: Array<Omit<ClassSession, keyof BaseRow> & { id: number }>): Promise<ClassSession[]> {
    if (!this.durable) return this.memory.seed<ClassSession>(TABLE, rows);
    const inserted: ClassSession[] = [];
    for (const row of rows) {
      const [saved] = await this.insertDb({ ...row }, true);
      if (saved) inserted.push(saved);
    }
    await this.syncSequence();
    this.memory.seedExact<ClassSession>(TABLE, inserted);
    return inserted;
  }

  async insert(data: Omit<ClassSession, keyof BaseRow>): Promise<ClassSession> {
    if (!this.durable) return this.memory.insert<ClassSession>(TABLE, data);
    const [saved] = await this.insertDb(data);
    if (!saved) throw new Error('class_sessions insert did not return a row');
    this.memory.seedExact<ClassSession>(TABLE, [saved]);
    return saved;
  }

  async update(id: number, patch: Partial<Omit<ClassSession, keyof BaseRow>>): Promise<ClassSession | undefined> {
    if (!this.durable) return this.memory.update<ClassSession>(TABLE, id, patch);
    const payload = this.toDbPayload(patch as Record<string, unknown>);
    const keys = Object.keys(payload);
    if (!keys.length) return this.memory.findById<ClassSession>(TABLE, id);
    const assignments = keys.map((key, i) => `${camelToSnake(key)} = $${i + 1}`);
    const values = keys.map((key) => payload[key]);
    values.push(id);
    const [row] = await this.query(
      `UPDATE ${TABLE} SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!row) return undefined;
    const saved = this.fromDbRow(row);
    this.memory.update<ClassSession>(TABLE, id, this.withoutBase(saved));
    return this.memory.findById<ClassSession>(TABLE, id) ?? saved;
  }

  async remove(id: number, deletedBy?: number): Promise<boolean> {
    if (!this.durable) return this.memory.remove(TABLE, id, deletedBy);
    const rows = await this.query(
      `UPDATE ${TABLE} SET deleted_at = now(), deleted_by = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
      [deletedBy ?? null, id],
    );
    if (!rows.length) return false;
    return this.memory.remove(TABLE, id, deletedBy);
  }

  private async insertDb(data: Record<string, unknown>, withId = false): Promise<ClassSession[]> {
    const payload = this.toDbPayload(data);
    if (!withId) delete payload.id;
    const keys = Object.keys(payload);
    const columns = keys.map(camelToSnake);
    const placeholders = keys.map((_, i) => `$${i + 1}`);
    const updates = columns
      .filter((c) => c !== 'id')
      .map((c) => `${c} = EXCLUDED.${c}`);
    const values = keys.map((k) => payload[k]);
    const conflict = withId
      ? ` ON CONFLICT (id) DO UPDATE SET ${updates.join(', ')}, updated_at = now()`
      : '';
    const rows = await this.query(
      `INSERT INTO ${TABLE} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${conflict} RETURNING *`,
      values,
    );
    return rows.map((r) => this.fromDbRow(r));
  }

  private async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id serial PRIMARY KEY,
        series_id integer,
        enrollment_id integer,
        course_id integer NOT NULL,
        instructor_id integer NOT NULL,
        room_id integer,
        student_id integer,
        payout_id integer,
        session_date date NOT NULL,
        start_time varchar(5) NOT NULL,
        end_time varchar(5),
        duration_minutes integer,
        status varchar(32) NOT NULL DEFAULT 'scheduled' CHECK (status IN (${sqlList(SESSION_STATUSES)})),
        kind varchar(32) NOT NULL DEFAULT 'class' CHECK (kind IN (${sqlList(SESSION_KINDS)})),
        mode varchar(32) NOT NULL DEFAULT 'in_person' CHECK (mode IN (${sqlList(SESSION_MODES)})),
        price integer,
        instructor_attendance varchar(32) CHECK (instructor_attendance IS NULL OR instructor_attendance IN (${sqlList(INSTRUCTOR_ATTENDANCE)})),
        topic varchar(200),
        memo text,
        color varchar(32),
        instructor_pay_amount integer,
        makeup_for_session_id integer,
        student_ids text NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        deleted_by integer
      )
    `);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_sessions_date ON ${TABLE} (session_date) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_sessions_instructor_date ON ${TABLE} (instructor_id, session_date) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_sessions_course ON ${TABLE} (course_id) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_sessions_series ON ${TABLE} (series_id) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON ${TABLE} (status) WHERE deleted_at IS NULL`);
    await this.query(`CREATE INDEX IF NOT EXISTS idx_sessions_payout_id ON ${TABLE} (payout_id) WHERE deleted_at IS NULL`);
    this.ready = true;
    this.logger.log('class_sessions table ready (Postgres-backed)');
  }

  private async hydrateMemory(): Promise<void> {
    const rows = await this.query(`SELECT * FROM ${TABLE} ORDER BY id ASC`);
    const sessions = rows.map((r) => this.fromDbRow(r));
    if (sessions.length) {
      this.memory.seedExact<ClassSession>(TABLE, sessions);
      this.logger.log(`hydrated ${sessions.length} class_sessions row(s) from Postgres`);
    }
    this.hydrated = true;
  }

  private async syncSequence(): Promise<void> {
    await this.query(`SELECT setval(pg_get_serial_sequence('${TABLE}', 'id'), COALESCE((SELECT MAX(id) FROM ${TABLE}), 1), true)`);
  }

  private async query(sql: string, params: unknown[] = []): Promise<DbRow[]> {
    const result = await this.postgres.getDataSource().query(sql, params);
    if (Array.isArray(result) && Array.isArray(result[0]) && typeof result[1] === 'number') {
      return result[0] as DbRow[];
    }
    return result as DbRow[];
  }

  private toDbPayload(src: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined) continue;
      if (key === 'studentIds') out[key] = JSON.stringify(Array.isArray(value) ? value : []);
      else out[key] = value;
    }
    return out;
  }

  private fromDbRow(row: DbRow): ClassSession {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) out[snakeToCamel(key)] = value;
    out.studentIds = parseJsonArray(row.student_ids) ?? [];
    out.sessionDate = toDateString(row.session_date);
    out.createdAt = toIso(row.created_at);
    out.updatedAt = toIso(row.updated_at);
    out.deletedAt = toIso(row.deleted_at);
    return out as ClassSession;
  }

  private withoutBase(row: ClassSession): Partial<Omit<ClassSession, keyof BaseRow>> {
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, deletedAt: _deletedAt, deletedBy: _deletedBy, ...rest } = row;
    return rest;
  }
}
