import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/config/configure-app';
import { loadLocalEnv } from '../src/config/load-env';
import { assertProductionBootSafety } from '../src/config/production-guards';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { ScheduleReadService } from '../src/modules/schedule/schedule-read.service';
import {
  markRuntimeReady,
  measurePerformance,
  measurePerformanceSync,
  resetPerformanceRuntimeForTest,
  setPerformanceObserver,
  type PerformancePayload,
} from '../src/common/performance-timing';

type SampleResult = {
  events: PerformancePayload[];
  roleBoundary: { schemaCreate: boolean };
};

type Stats = {
  count: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  cvPercent: number;
};

const WORKER_FLAG = '--worker';
const DISPOSABLE_KIND = 'disposable-neon-branch';

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePostgresUrl(raw: string, label: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${label} must be a valid URL`); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use postgresql protocol`);
  }
  return parsed;
}

function endpointIdentity(url: URL): string {
  return `${url.hostname.toLowerCase().replace(/-pooler(?=\.)/, '')}${url.pathname}`;
}

export function assertDisposablePerformanceTarget(
  raw: string | undefined,
  kind: string | undefined,
  productionUrls: Array<string | undefined>,
): URL {
  if (!raw) throw new Error('PERF_DATABASE_URL is required');
  if (kind !== DISPOSABLE_KIND) {
    throw new Error(`PERF_TARGET_KIND must be ${DISPOSABLE_KIND}`);
  }
  const target = parsePostgresUrl(raw, 'PERF_DATABASE_URL');
  if (!target.hostname.endsWith('.neon.tech') || !target.hostname.includes('-pooler.')) {
    throw new Error('PERF_DATABASE_URL must target a pooled Neon endpoint');
  }
  if (target.searchParams.get('sslmode')?.toLowerCase() !== 'verify-full') {
    throw new Error('PERF_DATABASE_URL must use sslmode=verify-full');
  }
  const targetIdentity = endpointIdentity(target);
  const matchesProduction = productionUrls.filter(Boolean).some((candidate) => {
    try { return endpointIdentity(parsePostgresUrl(candidate!, 'production URL')) === targetIdentity; }
    catch { return false; }
  });
  if (matchesProduction) throw new Error('Performance target matches a configured production endpoint');
  return target;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarize(values: readonly number[]): Stats {
  if (!values.length) throw new Error('Cannot summarize an empty sample');
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sorted.length;
  return {
    count: sorted.length,
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    max: round(sorted[sorted.length - 1]),
    mean: round(mean),
    cvPercent: round(mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100),
  };
}

function safeResultJson(raw: string): SampleResult {
  const line = raw.trim().split('\n').reverse().find((candidate) => candidate.startsWith('{"events"'));
  if (!line) throw new Error('Performance worker returned no result');
  const parsed = JSON.parse(line) as SampleResult;
  if (!Array.isArray(parsed.events) || parsed.roleBoundary?.schemaCreate !== false) {
    throw new Error('Performance worker returned an invalid or owner-role result');
  }
  return parsed;
}

function childEnvironment(target: URL): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    RUNTIME_DATABASE_URL: target.toString(),
    DATABASE_URL: target.toString(),
    POSTGRES_URL: target.toString(),
    PERFORMANCE_LOGGING: 'true',
    PERFORMANCE_LOG_CONSOLE: 'false',
    RUNTIME_SCHEMA_DDL: 'false',
  };
}

function runWorker(target: URL, mode: 'cold' | 'warm', warmSamples: number): SampleResult {
  const started = performance.now();
  const worker = spawnSync(process.execPath, [__filename, WORKER_FLAG, mode, String(warmSamples)], {
    cwd: process.cwd(),
    env: childEnvironment(target),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (worker.status !== 0) {
    throw new Error(`Performance worker failed (${mode}, status=${worker.status ?? 'timeout'})`);
  }
  const result = safeResultJson(worker.stdout);
  if (mode === 'cold') {
    result.events.push({
      phase: 'sample.processColdTotal',
      durationMs: round(performance.now() - started),
      cold: true,
    });
  }
  return result;
}

function eventsByPhase(samples: readonly SampleResult[], phase: string): number[] {
  return samples.flatMap((sample) => sample.events.filter((event) => event.phase === phase).map((event) => event.durationMs));
}

function summarizeNamedEvents(samples: readonly SampleResult[], field: 'phase' | 'queryName'): Record<string, Stats> {
  const grouped = new Map<string, number[]>();
  for (const sample of samples) {
    for (const event of sample.events) {
      const key = event[field];
      if (!key) continue;
      grouped.set(key, [...(grouped.get(key) ?? []), event.durationMs]);
    }
  }
  return Object.fromEntries([...grouped].sort(([left], [right]) => left.localeCompare(right)).map(
    ([key, values]) => [key, summarize(values)],
  ));
}

function lifecycleCalls(samples: readonly SampleResult[]): { hooks: number; missing: number; duplicateInvocations: number } {
  const hookNames = new Set(samples.flatMap((sample) => sample.events
    .filter((event) => event.phase.startsWith('lifecycle.'))
    .map((event) => event.phase)));
  let duplicateInvocations = 0;
  for (const sample of samples) {
    const counts = new Map<string, number>();
    for (const event of sample.events.filter((candidate) => candidate.phase.startsWith('lifecycle.'))) {
      counts.set(event.phase, (counts.get(event.phase) ?? 0) + 1);
    }
    if ([...counts.values()].some((count) => count > 1)) duplicateInvocations += 1;
  }
  return { hooks: hookNames.size, missing: Math.max(0, 37 - hookNames.size), duplicateInvocations };
}

function poolWaiting(samples: readonly SampleResult[]): Stats {
  const values = samples.flatMap((sample) => sample.events
    .map((event) => event.poolWaiting)
    .filter((value): value is number => value != null));
  return summarize(values.length ? values : [0]);
}

async function runWorkerProcess(mode: 'cold' | 'warm', warmSamples: number): Promise<void> {
  parsePostgresUrl(process.env.RUNTIME_DATABASE_URL ?? '', 'RUNTIME_DATABASE_URL');
  resetPerformanceRuntimeForTest();
  const events: PerformancePayload[] = [];
  const restoreObserver = setPerformanceObserver((event) => events.push(event));
  const app = await measurePerformance('sample.coldTotal', async () => {
    measurePerformanceSync('boot.productionGuard', () => assertProductionBootSafety());
    const created = await measurePerformance('boot.nestCreate', () => NestFactory.create(AppModule, { logger: false }));
    measurePerformanceSync('boot.configureApp', () => configureApp(created, { cors: false, observability: false }));
    await measurePerformance('boot.appInit', () => created.init());
    markRuntimeReady();
    return created;
  });
  try {
    const postgres = app.get(PostgresConnectionService);
    const [boundary] = await postgres.query<{ schemaCreate: boolean }>(
      `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS "schemaCreate"`,
      [],
      { queryName: 'db.benchmarkRoleBoundary' },
    );
    if (!boundary || boundary.schemaCreate) throw new Error('Benchmark requires a DML-only runtime role');
    const [range] = await postgres.query<{ from: string; to: string }>(
      `SELECT (COALESCE(MAX(session_date), current_date) - 30)::text AS "from",
              COALESCE(MAX(session_date), current_date)::text AS "to"
         FROM class_sessions WHERE deleted_at IS NULL`,
      [],
      { queryName: 'sessions.benchmarkRange' },
    );
    if (!range) throw new Error('Benchmark range query returned no row');
    const schedule = app.get(ScheduleReadService);
    await schedule.listFresh(range);
    const iterations = mode === 'warm' ? warmSamples : 1;
    for (let index = 0; index < iterations; index += 1) {
      await measurePerformance('sample.calendarWarm', () => schedule.listFresh(range));
    }
    process.stdout.write(`${JSON.stringify({ events, roleBoundary: boundary } satisfies SampleResult)}\n`);
  } finally {
    restoreObserver();
    await app.close();
  }
}

async function main(): Promise<void> {
  const perfUrl = process.env.PERF_DATABASE_URL;
  const perfKind = process.env.PERF_TARGET_KIND;
  loadLocalEnv();
  const target = assertDisposablePerformanceTarget(perfUrl, perfKind, [
    process.env.RUNTIME_DATABASE_URL,
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_PRISMA_URL,
  ]);
  const warmCount = positiveInteger(process.env.PERF_WARM_SAMPLES, 200);
  const requestedCold = positiveInteger(process.env.PERF_COLD_SAMPLES, 20);
  const warm = runWorker(target, 'warm', warmCount);
  const cold: SampleResult[] = [];
  for (let index = 0; index < requestedCold; index += 1) cold.push(runWorker(target, 'cold', 1));
  let coldStats = summarize(eventsByPhase(cold, 'sample.processColdTotal'));
  if (coldStats.cvPercent > 20 && cold.length < 50) {
    while (cold.length < 50) cold.push(runWorker(target, 'cold', 1));
    coldStats = summarize(eventsByPhase(cold, 'sample.processColdTotal'));
  }
  const all = [warm, ...cold];
  const targetFingerprint = createHash('sha256').update(endpointIdentity(target)).digest('hex').slice(0, 12);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    targetKind: DISPOSABLE_KIND,
    targetFingerprint,
    roleBoundary: 'dml-only',
    warm: summarize(eventsByPhase([warm], 'sample.calendarWarm')),
    cold: coldStats,
    appInit: summarize(eventsByPhase(cold, 'boot.appInit')),
    poolWaiting: poolWaiting(all),
    lifecycle: lifecycleCalls(cold),
    phases: summarizeNamedEvents(all, 'phase'),
    queries: summarizeNamedEvents(all, 'queryName'),
    measuredAt: new Date().toISOString(),
  })}\n`);
}

if (process.argv[2] === WORKER_FLAG) {
  const mode = process.argv[3] === 'warm' ? 'warm' : 'cold';
  runWorkerProcess(mode, positiveInteger(process.argv[4], 1)).catch(() => { process.exitCode = 1; });
} else if (require.main === module) {
  const started = performance.now();
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Performance baseline failed'}\n`);
    process.exitCode = 1;
  }).finally(() => {
    if (process.env.PERFORMANCE_LOGGING === 'true') {
      process.stderr.write(`performance baseline runner elapsedMs=${round(performance.now() - started)}\n`);
    }
  });
}
