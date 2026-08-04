import type { Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { isProduction } from './env';
import { logLine } from './log-line';

export type PerformancePoolSnapshot = {
  poolTotal?: number;
  poolIdle?: number;
  poolWaiting?: number;
};

export type PerformanceDetails = PerformancePoolSnapshot & {
  queryName?: string;
  rowCount?: number;
};

export type PerformancePayload = PerformanceDetails & {
  phase: string;
  durationMs: number;
  cold: boolean;
};

type PerformanceLogSink = Pick<Logger, 'log'>;

const defaultLogger: PerformanceLogSink = {
  log(message: string): void {
    // Nest route discovery is muted during serverless cold start; performance JSON must remain visible.
    // eslint-disable-next-line no-console
    console.log(message);
  },
};
const SAFE_NAME = /^[a-z][A-Za-z0-9_.-]{1,79}$/;
let runtimeReady = false;
let firstRequestStarted = false;

function safeCount(value: number | undefined): number | undefined {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.round(Number(value)) : undefined;
}

function safeName(value: string | undefined, field: 'phase' | 'queryName'): string | undefined {
  if (value == null) return undefined;
  if (!SAFE_NAME.test(value)) throw new Error(`Unsafe performance ${field}`);
  return value;
}

/**
 * Performance logs deliberately accept a closed field set. SQL, parameters, URLs, actor IDs,
 * request bodies and error messages cannot enter this payload.
 */
export function buildPerformancePayload(input: PerformancePayload): PerformancePayload {
  const phase = safeName(input.phase, 'phase');
  if (!phase) throw new Error('Performance phase is required');
  const queryName = safeName(input.queryName, 'queryName');
  return {
    phase,
    durationMs: Math.max(0, Math.round(input.durationMs * 100) / 100),
    cold: input.cold,
    ...(queryName ? { queryName } : {}),
    ...(safeCount(input.rowCount) != null ? { rowCount: safeCount(input.rowCount) } : {}),
    ...(safeCount(input.poolTotal) != null ? { poolTotal: safeCount(input.poolTotal) } : {}),
    ...(safeCount(input.poolIdle) != null ? { poolIdle: safeCount(input.poolIdle) } : {}),
    ...(safeCount(input.poolWaiting) != null ? { poolWaiting: safeCount(input.poolWaiting) } : {}),
  };
}

export function performanceLoggingEnabled(): boolean {
  const explicit = process.env.PERFORMANCE_LOGGING?.trim().toLowerCase();
  if (explicit != null && explicit !== '') return explicit === 'true';
  return isProduction();
}

export function isRuntimeCold(): boolean {
  return !runtimeReady;
}

export function markRuntimeReady(): void {
  runtimeReady = true;
}

export function resetPerformanceRuntimeForTest(): void {
  runtimeReady = false;
  firstRequestStarted = false;
}

function emitPerformance(payload: PerformancePayload, sink: PerformanceLogSink): void {
  if (!performanceLoggingEnabled()) return;
  try {
    sink.log(logLine('app', buildPerformancePayload(payload)));
  } catch {
    // Observability must never change command/query results or exception semantics.
  }
}

export async function measurePerformance<T>(
  phase: string,
  operation: () => Promise<T>,
  details?: PerformanceDetails | ((result: T) => PerformanceDetails),
  sink: PerformanceLogSink = defaultLogger,
): Promise<T> {
  if (!performanceLoggingEnabled()) return operation();
  const started = performance.now();
  const cold = isRuntimeCold();
  let result: T | undefined;
  let completed = false;
  try {
    result = await operation();
    completed = true;
    return result;
  } finally {
    const resolved = completed
      ? typeof details === 'function'
        ? details(result as T)
        : details
      : typeof details === 'function'
        ? undefined
        : details;
    emitPerformance(
      {
        phase,
        durationMs: performance.now() - started,
        cold,
        ...resolved,
      },
      sink,
    );
  }
}

export function measurePerformanceSync<T>(
  phase: string,
  operation: () => T,
  details?: PerformanceDetails | ((result: T) => PerformanceDetails),
  sink: PerformanceLogSink = defaultLogger,
): T {
  if (!performanceLoggingEnabled()) return operation();
  const started = performance.now();
  const cold = isRuntimeCold();
  let result: T | undefined;
  let completed = false;
  try {
    result = operation();
    completed = true;
    return result;
  } finally {
    const resolved = completed
      ? typeof details === 'function'
        ? details(result as T)
        : details
      : typeof details === 'function'
        ? undefined
        : details;
    emitPerformance(
      {
        phase,
        durationMs: performance.now() - started,
        cold,
        ...resolved,
      },
      sink,
    );
  }
}

export async function measureFirstRequest<T>(
  operation: () => Promise<T>,
  sink: PerformanceLogSink = defaultLogger,
): Promise<T> {
  if (firstRequestStarted) return operation();
  firstRequestStarted = true;
  return measurePerformance('boot.firstRequest', operation, undefined, sink);
}

/** Explicit decorator keeps lifecycle coverage visible in code review and avoids Nest internals. */
export function TimedModuleInit(): ClassDecorator {
  return (target) => {
    const prototype = (target as unknown as { prototype: { onModuleInit?: () => unknown } }).prototype;
    const original = prototype.onModuleInit;
    if (typeof original !== 'function') throw new Error(`${target.name} has no onModuleInit hook`);
    prototype.onModuleInit = function timedOnModuleInit(this: unknown): Promise<unknown> {
      return measurePerformance(`lifecycle.${target.name}.onModuleInit`, () => Promise.resolve(original.call(this)));
    };
  };
}
