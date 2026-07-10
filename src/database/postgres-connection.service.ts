import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
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

@Injectable()
export class PostgresConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresConnectionService.name);
  private dataSource: DataSource | null = null;
  private lastError: string | null = null;
  private initPromise: Promise<void> | null = null;

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
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
      extra: {
        max: numberEnv('DB_POOL_MAX', 5),
        connectionTimeoutMillis: numberEnv('DB_CONNECT_TIMEOUT_MS', 5000),
        idleTimeoutMillis: numberEnv('DB_IDLE_TIMEOUT_MS', 10000),
      },
    });

    try {
      await this.dataSource.initialize();
      await this.dataSource.query('select 1 as ok');
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

  private async destroyDataSource(): Promise<void> {
    if (!this.dataSource?.isInitialized) return;
    await this.dataSource.destroy();
    this.dataSource = null;
  }
}
