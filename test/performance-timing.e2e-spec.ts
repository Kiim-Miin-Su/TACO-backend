import {
  buildPerformancePayload,
  markRuntimeReady,
  measurePerformance,
  measurePerformanceSync,
  resetPerformanceRuntimeForTest,
  setPerformanceObserver,
  TimedModuleInit,
} from '../src/common/performance-timing';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { assertDisposablePerformanceTarget, summarize } from '../scripts/performance-baseline';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('[TBO-84 84A] performance timing contract', () => {
  const originalLogging = process.env.PERFORMANCE_LOGGING;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.PERFORMANCE_LOGGING = 'true';
    process.env.NODE_ENV = 'test';
    resetPerformanceRuntimeForTest();
  });

  afterAll(() => {
    if (originalLogging == null) delete process.env.PERFORMANCE_LOGGING;
    else process.env.PERFORMANCE_LOGGING = originalLogging;
    if (originalNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    resetPerformanceRuntimeForTest();
  });

  it('uses a closed, PII-free payload and normalizes numeric counters', () => {
    const payload = buildPerformancePayload({
      phase: 'db.query',
      durationMs: 1.236,
      cold: true,
      queryName: 'sessions.range',
      rowCount: 2.4,
      poolTotal: 5,
      poolIdle: 4,
      poolWaiting: -1,
      ...({ sql: 'SELECT secret', actorId: 7 } as unknown as Record<string, never>),
    });

    expect(payload).toEqual({
      phase: 'db.query',
      durationMs: 1.24,
      cold: true,
      queryName: 'sessions.range',
      rowCount: 2,
      poolTotal: 5,
      poolIdle: 4,
    });
    expect(Object.keys(payload)).not.toEqual(expect.arrayContaining(['sql', 'actorId', 'url', 'params']));
    expect(() => buildPerformancePayload({ phase: 'db.query\nforged', durationMs: 1, cold: true })).toThrow(
      'Unsafe performance phase',
    );
  });

  it('preserves async result/error semantics and records cold state at operation start', async () => {
    const lines: string[] = [];
    const sink = { log: (line: string) => lines.push(line) };
    await expect(measurePerformance('db.query', async () => ['row'], (rows) => ({
      queryName: 'sessions.range',
      rowCount: rows.length,
    }), sink)).resolves.toEqual(['row']);
    markRuntimeReady();
    await expect(measurePerformance('db.query', async () => {
      throw new Error('original failure');
    }, { queryName: 'sessions.range' }, sink)).rejects.toThrow('original failure');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('db.query');
    expect(lines[0]).toContain('true');
    expect(lines[1]).toContain('false');
    expect(lines.join(' ')).not.toContain('original failure');
  });

  it('preserves sync results and explicitly times decorated module init hooks', async () => {
    expect(measurePerformanceSync('boot.guard', () => 42)).toBe(42);

    @TimedModuleInit()
    class ExampleService {
      calls = 0;
      async onModuleInit(): Promise<void> {
        this.calls += 1;
      }
    }

    const service = new ExampleService();
    await service.onModuleInit();
    expect(service.calls).toBe(1);
  });

  it('keeps every production OnModuleInit hook explicitly instrumented', () => {
    const hooks = sourceFiles(join(__dirname, '..', 'src'))
      .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
      .filter(({ source }) => /implements[^\n{]*OnModuleInit/.test(source));

    expect(hooks).toHaveLength(37);
    expect(hooks.filter(({ source }) => !source.includes('@TimedModuleInit()')).map(({ path }) => path)).toEqual([]);
    expect(hooks.filter(({ source }) => !source.includes("performance-timing'")).map(({ path }) => path)).toEqual([]);
  });

  it('records named database query row/pool counters without SQL or parameters', async () => {
    const postgres = new PostgresConnectionService();
    const log = jest.spyOn((postgres as unknown as { logger: { log: (line: string) => void } }).logger, 'log')
      .mockImplementation(() => undefined);
    (postgres as unknown as { dataSource: unknown }).dataSource = {
      isInitialized: true,
      driver: { master: { totalCount: 5, idleCount: 4, waitingCount: 0 } },
      query: jest.fn(async () => [{ id: 1 }]),
    };

    await expect(postgres.query('SELECT secret FROM users WHERE id = $1', ['private'], {
      queryName: 'sessions.range',
    })).resolves.toEqual([{ id: 1 }]);

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain('sessions.range');
    expect(line).toContain('5');
    expect(line).not.toContain('SELECT secret');
    expect(line).not.toContain('private');
  });

  it('keeps observer failures isolated and restores the previous observer', async () => {
    const observed: string[] = [];
    const restore = setPerformanceObserver((event) => observed.push(event.phase));
    const restoreThrowing = setPerformanceObserver(() => { throw new Error('observer failure'); });
    await expect(measurePerformance('db.query', async () => 1)).resolves.toBe(1);
    restoreThrowing();
    await expect(measurePerformance('db.query', async () => 2)).resolves.toBe(2);
    restore();
    expect(observed).toEqual(['db.query']);
  });

  it('rejects production, unpooled and weak-TLS benchmark targets', () => {
    const production = 'postgresql://runtime:secret@ep-main.us-east-1.aws.neon.tech/neondb?sslmode=verify-full';
    const productionPooler = 'postgresql://runtime:secret@ep-main-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full';
    expect(() => assertDisposablePerformanceTarget(productionPooler, 'disposable-neon-branch', [production]))
      .toThrow('matches a configured production endpoint');
    expect(() => assertDisposablePerformanceTarget(
      'postgresql://runtime:secret@ep-qa.us-east-1.aws.neon.tech/neondb?sslmode=verify-full',
      'disposable-neon-branch',
      [production],
    )).toThrow('pooled Neon endpoint');
    expect(() => assertDisposablePerformanceTarget(
      'postgresql://runtime:secret@ep-qa-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require',
      'disposable-neon-branch',
      [production],
    )).toThrow('sslmode=verify-full');
  });

  it('calculates deterministic nearest-rank percentiles and variation', () => {
    expect(summarize([10, 20, 30, 40, 50])).toEqual({
      count: 5,
      p50: 30,
      p95: 50,
      max: 50,
      mean: 30,
      cvPercent: 47.14,
    });
  });
});
