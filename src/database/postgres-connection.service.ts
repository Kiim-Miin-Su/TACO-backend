import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { isProduction } from '../common/env'; // [P2 M4]
import { assertPgUrlPolicy, resolvePgSsl } from './pg-ssl'; // [TBO-34 C2-C]
import { AsyncLocalStorage } from 'async_hooks';
import { DataSource, type EntityManager } from 'typeorm';
import { runtimeDatabaseUrl } from './database-url';

export type DatabaseConnectionStatus = {
  runtimeStore: 'in-memory' | 'postgres';
  configured: boolean;
  ready: boolean;
  host?: string;
  database?: string;
  latencyMs?: number;
  error?: string;
};

const numberEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function safeUrlInfo(url: string): Pick<DatabaseConnectionStatus, 'host' | 'database'> {
  try {
    const u = new URL(url);
    return { host: u.host, database: u.pathname.replace(/^\//, '') || undefined };
  } catch {
    return {};
  }
}

export function runtimeSchemaDdlEnabled(): boolean {
  assertRuntimeDdlPolicy();
  const explicit = process.env.RUNTIME_SCHEMA_DDL?.trim().toLowerCase();
  if (explicit != null && explicit !== '') return explicit === 'true';
  return !isProduction(); // [P2 M4]
}

/** [TBO-34 C2-C] production에서 runtime DDL을 env로 재활성화하는 뒷문을 막는다(스키마 변경 = versioned migration 전용).
 *  ddl() 단일 깔때기의 skip에 더해, 재활성화 시도 자체를 부팅·호출 시점에 fail-fast로 끊는다. */
export function assertRuntimeDdlPolicy(): void {
  if (!isProduction()) return; // [P2 M4]
  const explicit = process.env.RUNTIME_SCHEMA_DDL?.trim().toLowerCase();
  if (explicit === 'true') {
    throw new Error('[db] production에서 RUNTIME_SCHEMA_DDL=true는 허용되지 않습니다 — 스키마 변경은 versioned migration 전용입니다(TBO-34 C2-C).');
  }
}

@Injectable()
export class PostgresConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresConnectionService.name);
  private dataSource: DataSource | null = null;
  private lastError: string | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly transactionContext = new AsyncLocalStorage<EntityManager>();

  get configured(): boolean {
    return !!runtimeDatabaseUrl();
  }

  get ready(): boolean {
    return this.dataSource?.isInitialized === true;
  }

  get runtimeStore(): 'in-memory' | 'postgres' {
    return this.ready ? 'postgres' : 'in-memory';
  }

  async onModuleInit(): Promise<void> {
    await this.ensureInitialized();
  }

  async ensureInitialized(): Promise<void> {
    const url = runtimeDatabaseUrl();
    assertPgUrlPolicy(url); // [TBO-34 C2-C] production sslmode=disable 금지 — 부팅 fail-fast
    assertRuntimeDdlPolicy(); // [TBO-34 C2-C] production RUNTIME_SCHEMA_DDL 재활성화 금지 — 부팅 fail-fast
    if (!url) {
      this.logger.log('DATABASE_URL/POSTGRES_URL not set — running with in-memory store');
      return;
    }
    if (this.dataSource?.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize(url).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async initialize(url: string): Promise<void> {
    this.dataSource = new DataSource({
      type: 'postgres',
      url,
      synchronize: false,
      migrationsRun: false,
      logging: process.env.DB_LOGGING === 'true',
      entities: [],
      migrations: [],
      ssl: resolvePgSsl(), // [TBO-34 C2-C] TLS 단일 진실원 — production은 인증서·hostname 검증 강제
      extra: {
        max: numberEnv('DB_POOL_MAX', 5),
        connectionTimeoutMillis: numberEnv('DB_CONNECT_TIMEOUT_MS', 5000),
        idleTimeoutMillis: numberEnv('DB_IDLE_TIMEOUT_MS', 10000),
        statement_timeout: numberEnv('DB_STATEMENT_TIMEOUT_MS', 15000),
      },
    });

    try {
      await this.dataSource.initialize();
      await this.dataSource.query('select 1 as ok');
      this.attachPoolErrorLogger();
      this.lastError = null;
      const info = safeUrlInfo(url);
      this.logger.log(`Postgres connection ready${info.host ? ` (${info.host})` : ''}`);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      await this.destroyDataSource();
      throw e;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.destroyDataSource();
  }

  async ping(): Promise<DatabaseConnectionStatus> {
    const url = runtimeDatabaseUrl();
    const info = url ? safeUrlInfo(url) : {};
    if (!url) {
      return { runtimeStore: 'in-memory', configured: false, ready: false };
    }
    if (!this.dataSource?.isInitialized) {
      return {
        runtimeStore: 'in-memory',
        configured: true,
        ready: false,
        ...info,
        error: this.lastError ?? 'Postgres data source is not initialized',
      };
    }
    const started = Date.now();
    try {
      await this.dataSource.query('select 1 as ok');
      this.lastError = null;
      return {
        runtimeStore: 'postgres',
        configured: true,
        ready: true,
        ...info,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return {
        runtimeStore: 'in-memory',
        configured: true,
        ready: false,
        ...info,
        latencyMs: Date.now() - started,
        error: this.lastError,
      };
    }
  }

  getDataSource(): DataSource {
    if (!this.dataSource?.isInitialized) throw new Error('Postgres data source is not initialized');
    return this.dataSource;
  }

  /** 현재 AsyncLocalStorage 문맥이 transaction 안인지(중첩 passthrough 판정과 동일 근거). */
  get inTransaction(): boolean {
    return !!this.transactionContext.getStore();
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const executor = this.transactionContext.getStore() ?? this.getDataSource();
    return executor.query(sql, params) as Promise<T[]>;
  }

  // [TBO-28B] 스키마 DDL 전용 실행기 — 부팅 시 여러 모듈 onModuleInit이 병렬로 CREATE TABLE/INDEX
  //  IF NOT EXISTS를 실행하면 pg가 pg_class unique 충돌(23505)·duplicate(42P07/42710)을 낼 수 있다
  //  (IF NOT EXISTS는 동시 실행에 원자적이지 않음 — fresh DB 부팅 레이스, 28B에서 실측).
  //  → 프로세스 내 직렬화(chain) + 중복 오류 무해 처리로 결정론화한다.
  private ddlChain: Promise<void> = Promise.resolve();

  async ddl(sql: string): Promise<void> {
    // Production schema changes belong to versioned migrations. Skipping runtime DDL also
    // prevents separate serverless cold starts from racing on CREATE/ALTER/INDEX. The first
    // real SELECT/INSERT still fails closed when a required migration is missing.
    if (!runtimeSchemaDdlEnabled()) return;
    const run = this.ddlChain.then(async () => {
      try {
        await this.query(sql);
      } catch (e) {
        const code = (e as { code?: string })?.code
          ?? (e as { driverError?: { code?: string } })?.driverError?.code;
        if (code === '42P07' || code === '42710' || code === '23505') return; // 이미 존재 — 무해
        throw e;
      }
    });
    // 체인은 실패해도 계속 흐르게(다음 DDL이 이전 실패에 묶이지 않게) 하되, 호출자에게는 원 결과 전달.
    this.ddlChain = run.catch(() => undefined);
    return run;
  }

  async transaction<R>(fn: () => Promise<R>): Promise<R> {
    if (!this.ready) return fn();
    if (this.transactionContext.getStore()) return fn();
    return this.getDataSource().transaction((manager) => this.transactionContext.run(manager, fn));
  }

  private attachPoolErrorLogger(): void {
    const pool = (this.dataSource?.driver as unknown as { master?: { on?: (event: string, cb: (err: Error) => void) => void } })?.master;
    pool?.on?.('error', (err) => {
      this.lastError = err.message;
      this.logger.warn(`Postgres pool idle client error: ${err.message}`);
    });
  }

  private async destroyDataSource(): Promise<void> {
    if (!this.dataSource?.isInitialized) return;
    await this.dataSource.destroy();
    this.dataSource = null;
  }
}
