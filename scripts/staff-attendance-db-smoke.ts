import 'reflect-metadata';
import { config } from 'dotenv';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { StaffAttendanceService } from '../src/modules/staff-attendance/staff-attendance.service';
import { AuditService } from '../src/modules/audit/audit.service';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });
process.env.TEST_BUSINESS_FIXTURES ??= '0';

type IdRow = { id: number };
type DateRow = { work_date: string };

function requireEnv(): void {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for staff attendance DB smoke');
  }
}

async function selectFixture(pg: PostgresConnectionService): Promise<{ actorId: number; staffId: number; workDate: string }> {
  const [actor] = await pg.query<IdRow>(`
    SELECT id
    FROM users
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND role IN ('super_admin', 'admin', 'manager')
    ORDER BY CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id
    LIMIT 1
  `);
  const [staff] = await pg.query<IdRow>(`
    SELECT id
    FROM users
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND role = 'instructor'
    ORDER BY id
    LIMIT 1
  `);
  if (!actor || !staff) throw new Error('Active manager/admin actor and instructor fixtures are required');
  const [freeDate] = await pg.query<DateRow>(`
    SELECT candidate::date::text AS work_date
    FROM generate_series(DATE '2099-01-01', DATE '2099-12-31', INTERVAL '1 day') AS candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM staff_attendance_records record
      WHERE record.staff_id = $1
        AND record.work_date = candidate::date
        AND record.deleted_at IS NULL
    )
    ORDER BY candidate
    LIMIT 1
  `, [staff.id]);
  if (!freeDate) throw new Error('No free 2099 work date is available for DB smoke');
  return { actorId: Number(actor.id), staffId: Number(staff.id), workDate: freeDate.work_date };
}

async function main(): Promise<void> {
  requireEnv();
  let recordId = 0;
  let fixture!: { actorId: number; staffId: number; workDate: string };

  {
    console.log('[staff-attendance-smoke] boot app #1');
    const app = await createTestApp();
    console.log('[staff-attendance-smoke] select DB fixtures');
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    fixture = await selectFixture(pg);
    const service = app.get(StaffAttendanceService);
    const created = await service.upsert({
      staffId: fixture.staffId,
      workDate: fixture.workDate,
      status: 'present',
      checkInAt: `${fixture.workDate}T09:00:00+09:00`,
      checkOutAt: `${fixture.workDate}T18:00:00+09:00`,
      memo: 'staff-attendance DB smoke create',
    }, fixture.actorId);
    recordId = Number(created.id);
    if (!recordId || created.status !== 'present') throw new Error('Staff attendance create failed');
    console.log('[staff-attendance-smoke] created record');
    await app.close();
  }

  {
    console.log('[staff-attendance-smoke] boot app #2');
    const app = await createTestApp();
    const service = app.get(StaffAttendanceService);
    const rows = await service.list({ from: fixture.workDate, to: fixture.workDate, staffId: fixture.staffId });
    const persisted = rows.find((row) => Number(row.id) === recordId);
    if (!persisted || persisted.status !== 'present' || persisted.memo !== 'staff-attendance DB smoke create') {
      throw new Error(`Staff attendance create did not survive restart: ${JSON.stringify(rows)}`);
    }
    const updated = await service.upsert({
      staffId: fixture.staffId,
      workDate: fixture.workDate,
      status: 'paid_leave',
      memo: 'staff-attendance DB smoke update',
    }, fixture.actorId);
    if (Number(updated.id) !== recordId || updated.status !== 'paid_leave') {
      throw new Error(`Staff attendance update did not preserve identity: ${JSON.stringify(updated)}`);
    }
    console.log('[staff-attendance-smoke] read and updated record');
    await app.close();
  }

  {
    console.log('[staff-attendance-smoke] boot app #3');
    const app = await createTestApp();
    const service = app.get(StaffAttendanceService);
    const audit = app.get(AuditService);
    const rows = await service.list({ from: fixture.workDate, to: fixture.workDate, staffId: fixture.staffId });
    const persisted = rows.find((row) => Number(row.id) === recordId);
    if (!persisted || persisted.status !== 'paid_leave' || persisted.memo !== 'staff-attendance DB smoke update') {
      throw new Error(`Staff attendance update did not survive restart: ${JSON.stringify(rows)}`);
    }
    const beforeDeleteAudit = await audit.list({ entity: 'staff_attendance_records', entityId: recordId });
    const beforeActions = new Set(beforeDeleteAudit.map((row) => row.action));
    if (!beforeActions.has('create') || !beforeActions.has('update')) {
      throw new Error(`Staff attendance create/update audit missing: ${JSON.stringify([...beforeActions])}`);
    }
    await service.remove(recordId, 'staff-attendance DB smoke cleanup', fixture.actorId);
    console.log('[staff-attendance-smoke] verified audit and removed record');
    await app.close();
  }

  {
    console.log('[staff-attendance-smoke] boot app #4');
    const app = await createTestApp();
    const service = app.get(StaffAttendanceService);
    const audit = app.get(AuditService);
    const rows = await service.list({ from: fixture.workDate, to: fixture.workDate, staffId: fixture.staffId });
    if (rows.some((row) => Number(row.id) === recordId)) {
      throw new Error(`Staff attendance ${recordId} remained active after delete/restart`);
    }
    const events = await audit.list({ entity: 'staff_attendance_records', entityId: recordId });
    const actions = new Set(events.map((row) => row.action));
    if (!actions.has('create') || !actions.has('update') || !actions.has('delete')) {
      throw new Error(`Staff attendance audit lifecycle incomplete: ${JSON.stringify([...actions])}`);
    }
    await app.close();
  }

  console.log(JSON.stringify({
    ok: true,
    recordId,
    workDate: fixture.workDate,
    persistedAcrossRestarts: true,
    activeAfterCleanup: false,
    auditActions: ['create', 'update', 'delete'],
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
