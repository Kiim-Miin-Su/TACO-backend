import { INestApplication } from '@nestjs/common';
import { assertExpectedAfter } from '../src/common/expected-after.util';
import {
  AUDIT_LOG_SPEC,
  SESSION_REPORTS_SPEC,
} from '../src/database/calendar-asset-specs';
import { CalendarUnitOfWork, type CalendarLockKey } from '../src/database/calendar-unit-of-work.service';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { ClassSessionsStore } from '../src/modules/schedule/class-sessions.store';
import { ScheduleService } from '../src/modules/schedule/schedule.service';
import { teachingMinutesOf } from '../src/modules/schedule/session-accounting.policy';
import { SessionReportRow } from '../src/modules/reports/report.entity';
import { ReportsService } from '../src/modules/reports/reports.service';
import { createTestApp } from './setup-app';

const enabled = process.env.RUN_MONEY_RACE_E2E === '1';
const describePostgres = enabled ? describe : describe.skip;

type AuditRow = {
  id: number;
  entity: string;
  entityId: number;
  action: string;
  changes?: Record<string, { before?: unknown; after?: unknown }>;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  deletedBy?: number | null;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertIsolatedLocalDatabase(): void {
  const raw = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!raw) {
    throw new Error('RUN_MONEY_RACE_E2E=1 requires DATABASE_URL for an isolated local PostgreSQL database.');
  }

  const url = new URL(raw);
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  const database = url.pathname.replace(/^\//, '');
  if (!localHosts.has(url.hostname) || !/(?:test|e2e|race|qa|tmp)/i.test(database)) {
    throw new Error(
      `Refusing report concurrency test outside an isolated local test database (host=${url.hostname}, database=${database}).`,
    );
  }
}

function hasSessionTarget(keys: CalendarLockKey[], sessionId: number): boolean {
  return keys.some((key) => key.kind === 'session' && key.id === sessionId);
}

function statusTransitions(rows: AuditRow[]): string[] {
  return rows
    .map((row) => row.changes?.status)
    .filter((status): status is { before?: unknown; after?: unknown } => status != null)
    .map((status) => `${String(status.before)}->${String(status.after)}`);
}

describePostgres('report approve vs session terminal two-instance PostgreSQL concurrency (e2e)', () => {
  let appA: INestApplication;
  let appB: INestApplication | undefined;
  let storeA: PostgresCollectionStore;
  let sessionsA: ClassSessionsStore;
  let reportsA: ReportsService;
  const actorApprove = 910001;
  const actorTerminal = 910002;
  const created: Array<{ sessionId: number; reportId: number }> = [];

  beforeAll(async () => {
    assertIsolatedLocalDatabase();
    process.env.TEST_BUSINESS_FIXTURES = '0';
    appA = await createTestApp();
    storeA = appA.get(PostgresCollectionStore);
    sessionsA = appA.get(ClassSessionsStore);
    reportsA = appA.get(ReportsService);
  }, 120_000);

  afterEach(async () => {
    await appB?.close();
    appB = undefined;
  });

  afterAll(async () => {
    for (const { sessionId, reportId } of created.reverse()) {
      await storeA.remove(SESSION_REPORTS_SPEC, reportId, actorApprove);
      await sessionsA.remove(sessionId, actorApprove);
    }
    await appA?.close();
  }, 60_000);

  async function fixture(startTime: string): Promise<{ sessionId: number; reportId: number }> {
    const session = await sessionsA.insert({
      courseId: 990001,
      instructorId: 990002,
      sessionDate: '2020-01-06',
      startTime,
      endTime: startTime === '10:00' ? '11:00' : '12:00',
      durationMinutes: 60,
      status: 'scheduled',
      studentIds: [990003],
      kind: 'class',
      mode: 'online',
      topic: `report PG race ${startTime}`,
    });
    const report = await storeA.insert<SessionReportRow>(SESSION_REPORTS_SPEC, {
      sessionId: session.id,
      studentId: 990003,
      instructorId: session.instructorId,
      content: `PostgreSQL concurrency ${startTime}`,
      status: 'submitted',
      approvalStatus: 'submitted',
      submittedAt: new Date().toISOString(),
    });
    created.push({ sessionId: session.id, reportId: report.id });

    // The second Nest instance must hydrate the shared PostgreSQL rows before the race.
    appB = await createTestApp();
    return { sessionId: session.id, reportId: report.id };
  }

  async function readback(sessionId: number, reportId: number) {
    const session = await sessionsA.findByIdDb(sessionId);
    const [report] = await storeA.findActive<SessionReportRow>(SESSION_REPORTS_SPEC, {
      where: { id: reportId } as Partial<SessionReportRow>,
      limit: 1,
    });
    const audits = await storeA.findActive<AuditRow>(AUDIT_LOG_SPEC, {
      orderBy: { field: 'id' },
    });
    const reportAudits = audits.filter(
      (row) => row.entity === 'session_reports' && row.entityId === reportId && row.action === 'approve',
    );
    const sessionAudits = audits.filter(
      (row) => row.entity === 'class_sessions' && row.entityId === sessionId && row.action === 'update',
    );
    return {
      session,
      report,
      reportAudits,
      sessionAudits,
      teachingMinutes: session ? teachingMinutesOf(session) : undefined,
    };
  }

  async function expectBlocked(promise: Promise<unknown>): Promise<void> {
    let settled = false;
    void promise.finally(() => {
      settled = true;
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);
  }

  async function holdSessionLock(
    app: INestApplication,
    sessionId: number,
  ): Promise<{ acquired: Promise<void>; release: () => void; restore: () => void }> {
    const acquired = deferred();
    const release = deferred();
    const uow = app.get(CalendarUnitOfWork);
    const original = uow.lockTargets.bind(uow);
    const spy = jest.spyOn(uow, 'lockTargets').mockImplementation(async (keys) => {
      await original(keys);
      if (hasSessionTarget(keys, sessionId)) {
        acquired.resolve();
        await release.promise;
      }
    });
    return {
      acquired: acquired.promise,
      release: release.resolve,
      restore: () => spy.mockRestore(),
    };
  }

  it('terminal-first: cancel session lock serializes approve and leaves submitted report with zero hours', async () => {
    const { sessionId, reportId } = await fixture('10:00');
    const scheduleB = appB!.get(ScheduleService);
    const gate = await holdSessionLock(appB!, sessionId);

    const terminal = scheduleB.update(sessionId, {
      status: 'canceled',
      force: true,
      acknowledgeAccountingImpact: true,
    }, actorTerminal);
    await gate.acquired;

    const approve = reportsA.approve(reportId, actorApprove);
    await expectBlocked(approve);
    gate.release();

    await terminal;
    await expect(approve).rejects.toMatchObject({
      response: {
        code: 'SESSION_TERMINAL',
        sessionId,
        sessionStatus: 'canceled',
      },
    });
    gate.restore();

    const after = await readback(sessionId, reportId);
    assertExpectedAfter('PG terminal-first report/session expected/after', {
      sessionStatus: 'canceled',
      teachingMinutes: 0,
      reportStatus: 'submitted',
      reportApproveAuditCount: 0,
      sessionTransitions: ['scheduled->canceled'],
    }, {
      sessionStatus: after.session?.status,
      teachingMinutes: after.teachingMinutes,
      reportStatus: after.report?.approvalStatus,
      reportApproveAuditCount: after.reportAudits.length,
      sessionTransitions: statusTransitions(after.sessionAudits),
    });
  }, 30_000);

  it('approve-first: no_show waits on the same session lock and terminal state never revives to held', async () => {
    const { sessionId, reportId } = await fixture('11:00');
    const scheduleB = appB!.get(ScheduleService);
    const gate = await holdSessionLock(appA, sessionId);

    const approve = reportsA.approve(reportId, actorApprove);
    await gate.acquired;

    const terminal = scheduleB.update(sessionId, {
      status: 'no_show',
      force: true,
      acknowledgeAccountingImpact: true,
    }, actorTerminal);
    await expectBlocked(terminal);
    gate.release();

    await approve;
    await terminal;
    gate.restore();

    const after = await readback(sessionId, reportId);
    assertExpectedAfter('PG approve-first report/session expected/after', {
      sessionStatus: 'no_show',
      teachingMinutes: 0,
      reportStatus: 'approved',
      reportApproveAuditCount: 1,
      sessionTransitions: ['scheduled->held', 'held->no_show'],
    }, {
      sessionStatus: after.session?.status,
      teachingMinutes: after.teachingMinutes,
      reportStatus: after.report?.approvalStatus,
      reportApproveAuditCount: after.reportAudits.length,
      sessionTransitions: statusTransitions(after.sessionAudits),
    });
  }, 30_000);
});
