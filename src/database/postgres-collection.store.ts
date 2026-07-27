import { Injectable, Logger } from '@nestjs/common';
import type { BaseRow } from '../common/types/base';
import { InMemoryDatabase } from './in-memory.database';
import { PostgresConnectionService, runtimeSchemaDdlEnabled } from './postgres-connection.service';
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
  /** [TBO-28B] 멱등 스키마 마이그레이션(ALTER TABLE … ADD COLUMN IF NOT EXISTS 등).
   *  기존 테이블엔 createSql(CREATE TABLE IF NOT EXISTS)이 no-op이므로 신규 컬럼은 여기로만 도달한다.
   *  실행 순서: createSql → migrations → indexes. */
  migrations?: string[];
  indexes?: string[];
  jsonFields?: string[];
  dateFields?: string[];
  timestampFields?: string[];
  /** [EP4 2026-07-16] append-only 로그 컬렉션(audit_log·auth_events): PG durable일 때 insert의
   *  메모리 write-through를 생략한다. 조회(findActive)가 PG 직행이라 메모리 사본은 읽히지 않는데
   *  축출 없이 쌓여 RAM이 선형 증가했다. PG 불가(순수 메모리 모드)에서는 메모리가 곧 저장소라 유지. */
  skipMemoryWhenDurable?: boolean;
};

export type ActiveFindOptions<T extends BaseRow> = {
  where?: Partial<Record<keyof T & string, unknown>>;
  orderBy?: { field: keyof T & string; direction?: 'ASC' | 'DESC' };
  limit?: number;
};

export const safeSqlIdentifier = (identifier: string): string => {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return identifier;
};

const safeTable = (table: string): string => safeSqlIdentifier(table);

const safeColumn = (field: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) throw new Error(`Unsafe query field: ${field}`);
  return safeSqlIdentifier(camelToSnake(field));
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
    // [TBO-57 원천 픽스 2026-07-24] 런타임 DDL 금지(운영) 환경에서는 표 존재를 확인해야만 ready로
    //  캐시한다 — 종전엔 no-op DDL 후 무조건 캐시해, 부재 표가 ready로 오염되면 이후 hydrate의
    //  생존 가드까지 우회됐다. 부재 표는 명시적 오류로 fail-closed(READ·쓰기 차단 — 조용한 메모리
    //  폴백 금지). migration owner-paste 적용 후 다음 호출부터 자동 복구된다.
    if (!runtimeSchemaDdlEnabled()) {
      const [row] = await this.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${spec.table}`]);
      if ((row as { present?: boolean } | undefined)?.present !== true) {
        throw new Error(
          `[db] ${spec.table} 표가 없습니다 — versioned migration(owner-paste) 적용 전입니다. ` +
          '이 표의 READ·쓰기를 차단합니다(fail-closed). 부팅 hydrate는 생존 규약(빈 미러)으로 통과합니다.',
        );
      }
      this.readyTables.add(spec.table);
      return true;
    }
    // [TBO-28B] DDL은 postgres.ddl(직렬화+중복 무해)로 — 부팅 병렬 onModuleInit 레이스 차단.
    await this.postgres.ddl(spec.createSql);
    for (const migrationSql of spec.migrations ?? []) await this.postgres.ddl(migrationSql);
    for (const indexSql of spec.indexes ?? []) await this.postgres.ddl(indexSql);
    this.readyTables.add(spec.table);
    this.logger.log(`${spec.table} table ready (Postgres-backed)`);
    return true;
  }

  /** [TBO-57 원천 픽스 2026-07-24] hydrate = 표-부재 허용(운영 한정 경고 후 []).
   *  실측 사고: 신설 표(signup_phone_challenges)의 migration이 owner-paste 되기 전에 배포되면
   *  런타임 DDL 금지 정책상 표가 없고, 부팅 onModuleInit hydrate의 SELECT가 콜드스타트를
   *  전멸시켰다(/api/health 포함 전 라우트 다운). hydrate는 "메모리 미러 채우기"라 표 부재 시
   *  빈 미러가 정확한 표현 — 경고 로그 후 []를 반환해 부팅·재수화가 생존한다(전 서비스·미래
   *  신설 표 공통). fail-closed는 유지된다: findActive/insert/update/remove 등 실제 READ·쓰기는
   *  부재 표에서 SQL 오류로 즉시 실패하고(조용한 메모리 폴백 없음), 표 부재는 readyTables에
   *  캐시하지 않아 migration 적용 후 다음 요청/콜드스타트부터 자동 복구된다.
   *  비운영(런타임 DDL 허용)은 ensureReady가 표를 만들므로 이 분기가 발동하지 않는다. */
  async hydrate<T extends BaseRow>(spec: PostgresCollectionSpec): Promise<T[]> {
    await this.postgres.ensureInitialized();
    if (this.postgres.ready && !this.readyTables.has(spec.table) && !runtimeSchemaDdlEnabled()) {
      const [row] = await this.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${spec.table}`]);
      if ((row as { present?: boolean } | undefined)?.present !== true) {
        this.logger.warn(
          `${spec.table} 표가 아직 없습니다 — versioned migration(owner-paste) 적용 전. 부팅·재수화는 계속하고 이 표의 READ·쓰기는 SQL 오류로 fail-closed 됩니다.`,
        );
        return [];
      }
    }
    if (!(await this.ensureReady(spec))) return [];
    const table = safeTable(spec.table);
    const rows = await this.query(`SELECT * FROM ${table} ORDER BY id ASC`);
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
    const table = safeTable(spec.table);
    const rows = await this.query(
      `SELECT * FROM ${table} WHERE deleted_at IS NULL${conditions.length ? ` AND ${conditions.join(' AND ')}` : ''}${order}${limitSql}`,
      values,
    );
    return rows.map((row) => this.fromDbRow<T>(spec, row));
  }

  /** 여러 부모 FK의 종속 행을 한 번에 읽는다. 반복수업 명령의 잠금 보유 중 N+1 왕복을 피한다. */
  async findActiveByFieldValues<T extends BaseRow>(
    spec: PostgresCollectionSpec,
    field: keyof T & string,
    requestedValues: readonly unknown[],
  ): Promise<T[]> {
    const values: unknown[] = [
      ...new Set<unknown>(requestedValues.filter((value) => value !== undefined && value !== null)),
    ];
    if (!values.length) return [];
    if (!(await this.ensureReady(spec))) {
      const allowed = new Set(values);
      return this.memory.findAll<T>(spec.table).filter(
        (row) => allowed.has((row as Record<string, unknown>)[field]),
      );
    }
    const table = safeTable(spec.table);
    const column = safeColumn(field);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    const rows = await this.query(
      `SELECT * FROM ${table} WHERE deleted_at IS NULL AND ${column} IN (${placeholders}) ORDER BY id ASC`,
      values,
    );
    return rows.map((row) => this.fromDbRow<T>(spec, row));
  }

  /** 제품 참조 데이터(countries 등) bootstrap. 업무 데이터에는 사용하지 않는다. */
  async seedReference<T extends BaseRow>(spec: PostgresCollectionSpec, rows: Array<Omit<T, keyof BaseRow> & { id: number }>): Promise<T[]> {
    if (!(await this.ensureReady(spec))) return this.memory.seedReference<T>(spec.table, rows);
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
    // [EP4] append-only 로그는 durable 모드에서 메모리 미적재(조회는 PG 직행 — 사본은 죽은 무게).
    //  예외: NODE_ENV=test — PG-mode e2e가 db.findAll('audit_log'/'auth_events')로 기록을 검증하므로
    //  테스트에서는 write-through를 유지한다(프로세스 수명이 짧아 RAM 영향 없음).
    const skipMemory = spec.skipMemoryWhenDurable && process.env.NODE_ENV !== 'test';
    if (!skipMemory) this.memory.seedExact<T>(spec.table, [saved]);
    return saved;
  }

  /**
   * 활성 행의 partial unique key를 기준으로 원자 upsert한다.
   * 서버리스 인스턴스별 메모리 read model이 오래되어도 PostgreSQL unique index가 최종 직렬화한다.
   */
  async upsertActive<T extends BaseRow>(
    spec: PostgresCollectionSpec,
    conflictFields: Array<keyof T & string>,
    data: Omit<T, keyof BaseRow>,
  ): Promise<T> {
    if (!conflictFields.length) throw new Error('upsertActive requires at least one conflict field');
    if (!(await this.ensureReady(spec))) {
      const existing = this.memory.findAll<T>(spec.table).find((row) =>
        conflictFields.every((field) => row[field] === (data as Record<string, unknown>)[field]),
      );
      if (existing) {
        return this.memory.update<T>(spec.table, existing.id, data) ?? existing;
      }
      return this.memory.insert<T>(spec.table, data);
    }

    const payload = this.toDbPayload(spec, data as Record<string, unknown>);
    const keys = Object.keys(payload);
    const columns = keys.map(safeColumn);
    const conflictColumns = conflictFields.map(safeColumn);
    const conflictSet = new Set(conflictColumns);
    const updateColumns = columns.filter((column) => !conflictSet.has(column) && column !== 'id');
    if (!updateColumns.length) throw new Error('upsertActive requires at least one update field');
    const placeholders = keys.map((_, index) => `$${index + 1}`);
    const values = keys.map((key) => payload[key]);
    const table = safeTable(spec.table);
    const [row] = await this.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
       ON CONFLICT (${conflictColumns.join(', ')}) WHERE deleted_at IS NULL
       DO UPDATE SET ${updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(', ')}, updated_at = now()
       RETURNING *`,
      values,
    );
    if (!row) throw new Error(`${spec.table} upsert did not return a row`);
    const saved = this.fromDbRow<T>(spec, row);
    this.memory.seedExact<T>(spec.table, [saved]);
    return saved;
  }

  async update<T extends BaseRow>(spec: PostgresCollectionSpec, id: number, patch: Partial<Omit<T, keyof BaseRow>>): Promise<T | undefined> {
    if (!(await this.ensureReady(spec))) return this.memory.update<T>(spec.table, id, patch);
    const payload = this.toDbPayload(spec, patch as Record<string, unknown>);
    const keys = Object.keys(payload);
    if (!keys.length) return this.memory.findById<T>(spec.table, id);
    const assignments = keys.map((key, i) => `${safeColumn(key)} = $${i + 1}`);
    const values = keys.map((key) => payload[key]);
    values.push(id);
    const table = safeTable(spec.table);
    const [row] = await this.query(
      `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = now() WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!row) return undefined;
    const saved = this.fromDbRow<T>(spec, row);
    this.memory.update<T>(spec.table, id, this.withoutBase(saved));
    return this.memory.findById<T>(spec.table, id) ?? saved;
  }

  async remove(spec: PostgresCollectionSpec, id: number, deletedBy?: number): Promise<boolean> {
    if (!(await this.ensureReady(spec))) return this.memory.remove(spec.table, id, deletedBy);
    const table = safeTable(spec.table);
    const rows = await this.query(
      `UPDATE ${table} SET deleted_at = now(), deleted_by = $1, updated_at = now() WHERE id = $2 AND deleted_at IS NULL RETURNING id`,
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
    const table = safeTable(spec.table);
    const rows = await this.query(
      `UPDATE ${table} SET deleted_at = now(), deleted_by = $1, updated_at = now()
        WHERE ${safeColumn(field)} = $2 AND deleted_at IS NULL RETURNING id`,
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
    const assignments = patchKeys.map((key, index) => `${safeColumn(key)} = $${index + 1}`);
    values.push(id);
    const idParam = values.length;
    const conditions = expectedKeys.map((key) => {
      values.push(expectedPayload[key]);
      const column = safeColumn(key);
      // PostgreSQL timestamptz(μs) → JS ISO(ms) 왕복 뒤에도 같은 revision을 비교할 수 있게 정규화.
      // status/amount 같은 도메인 CAS와 함께 사용하므로 같은 ms의 서로 다른 전이를 허용하지 않는다.
      if (key === 'updatedAt') {
        return `date_trunc('milliseconds', ${column}) = date_trunc('milliseconds', $${values.length}::timestamptz)`;
      }
      return `${column} = $${values.length}`;
    });
    const table = safeTable(spec.table);
    const [row] = await this.query(
      `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = now()
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
    const columns = keys.map(safeColumn);
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
    const table = safeTable(spec.table);
    const rows = await this.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})${conflict} RETURNING *`,
      values,
    );
    return rows.map((row) => this.fromDbRow<T>(spec, row));
  }

  private async syncSequence(table: string): Promise<void> {
    const safe = safeTable(table);
    await this.query(`SELECT setval(pg_get_serial_sequence('${safe}', 'id'), COALESCE((SELECT MAX(id) FROM ${safe}), 1), true)`);
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
