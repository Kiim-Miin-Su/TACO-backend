import 'reflect-metadata';
import { config } from 'dotenv';
import request from 'supertest';
import { createTestApp } from '../test/setup-app';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { assertExpectedAfter } from '../src/common/expected-after.util';

config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });

type AttendanceRow = {
  id: number;
  sessionId: number;
  studentId: number;
  status: string;
};

type ReportRow = {
  id: number;
  sessionId: number;
  studentId: number;
  status: string;
  approvalStatus?: string;
  approvedBy?: number;
};

type ContractRow = {
  id: number;
  instructorId: number;
  monthlyHours: number;
  hourlyRate: number;
  active: boolean;
};

async function login(http: ReturnType<typeof request>, webId: string): Promise<string> {
  const res = await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201);
  return res.body.accessToken;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function requireEnv(): void {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL && !process.env.POSTGRES_PRISMA_URL) {
    throw new Error('DATABASE_URL/POSTGRES_URL is required for attendance/reports DB smoke');
  }
}

async function main(): Promise<void> {
  requireEnv();

  const stamp = Date.now();
  const day = String((stamp % 20) + 1).padStart(2, '0');
  const sessionDate = `2099-10-${day}`;
  const topic = `TBO-24-att-report-${stamp}`;
  let sessionId = 0;
  let attendanceId = 0;
  let reportId = 0;

  {
    const app = await createTestApp();
    const pg = app.get(PostgresConnectionService);
    if (!pg.ready) throw new Error('Postgres data source is not ready');
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');
    const ceo = await login(http, 'admin');

    const created = await http.post('/api/schedule')
      .set(auth(manager))
      .send({
        courseId: 10,
        instructorId: 1,
        roomId: 1,
        sessionDate,
        startTime: '07:00',
        endTime: '08:00',
        topic,
        kind: 'class',
        mode: 'online',
        studentIds: [4],
        force: true,
      })
      .expect(201);
    sessionId = created.body.row.id;

    const attendance = await http.put('/api/attendance')
      .set(auth(manager))
      .send({ sessionId, studentId: 4, status: 'absent' })
      .expect(200);
    attendanceId = attendance.body.id;

    const updatedAttendance = await http.put('/api/attendance')
      .set(auth(manager))
      .send({ sessionId, studentId: 4, status: 'late' })
      .expect(200);
    if (updatedAttendance.body.id !== attendanceId || updatedAttendance.body.status !== 'late') {
      throw new Error(`attendance upsert/update failed before restart: ${JSON.stringify(updatedAttendance.body)}`);
    }

    const report = await http.post('/api/reports')
      .set(auth(manager))
      .send({ sessionId, studentId: 4, content: `DB smoke report ${stamp}`, homework: 'Read pages 1-3' })
      .expect(201);
    reportId = report.body.id;
    if (report.body.status !== 'submitted' || report.body.approvalStatus !== 'submitted') {
      throw new Error(`report create did not return separated status fields: ${JSON.stringify(report.body)}`);
    }

    const approved = await http.post(`/api/reports/${reportId}/approve`)
      .set(auth(manager))
      .send({ approvedBy: 4 })
      .expect(201);
    if (approved.body.status !== 'submitted' || approved.body.approvalStatus !== 'approved') {
      throw new Error(`report approve did not set approvalStatus=approved: ${JSON.stringify(approved.body)}`);
    }

    const held = await http.patch(`/api/schedule/${sessionId}`).set(auth(manager)).send({ status: 'held', force: true });
    if (held.status !== 200) throw new Error(`session held transition failed: ${held.status} ${JSON.stringify(held.body)}`);
    const beforePreview = (await http.get(`/api/payouts/preview?instructorId=1&from=${sessionDate}&to=${sessionDate}`)
      .set(auth(ceo)).expect(200)).body;
    const beforeLine = beforePreview.lines.find((line: { sessionId: number }) => line.sessionId === sessionId);
    if (!beforeLine) throw new Error(`held+approved session ${sessionId} missing from payout preview`);
    const blocked = await http.patch(`/api/schedule/${sessionId}`).set(auth(manager))
      .send({ instructorAttendance: 'absent' }).expect(409);
    assertExpectedAfter('DB smoke accounting preview', {
      code: 'ACCOUNTING_IMPACT_ACK_REQUIRED',
      teachingMinutes: -60,
      computedAmount: -beforeLine.amount,
    }, {
      code: blocked.body.code,
      teachingMinutes: blocked.body.impact?.delta?.teachingMinutes,
      computedAmount: blocked.body.impact?.delta?.computedAmount,
    });
    await http.patch(`/api/schedule/${sessionId}`).set(auth(manager))
      .send({ instructorAttendance: 'absent', acknowledgeAccountingImpact: true }).expect(200);
    const absentPreview = (await http.get(`/api/payouts/preview?instructorId=1&from=${sessionDate}&to=${sessionDate}`)
      .set(auth(ceo)).expect(200)).body;
    if (absentPreview.lines.some((line: { sessionId: number }) => line.sessionId === sessionId))
      throw new Error(`absent session ${sessionId} remained payout eligible`);
    await http.patch(`/api/schedule/${sessionId}`).set(auth(manager))
      .send({ clearInstructorAttendance: true, acknowledgeAccountingImpact: true }).expect(200);

    const contracts = (await http.get('/api/instructor-contracts').set(auth(manager)).expect(200)).body as ContractRow[];
    if (!contracts.some((row) => row.instructorId === 1 && row.active && row.monthlyHours > 0 && row.hourlyRate > 0)) {
      throw new Error(`instructor contract seed/hydration missing before restart: ${JSON.stringify(contracts)}`);
    }
    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');
    const ceo = await login(http, 'admin');

    const attendance = (await http.get(`/api/attendance?sessionId=${sessionId}`)
      .set(auth(manager))
      .expect(200)).body as AttendanceRow[];
    const persistedAttendance = attendance.find((row) => row.id === attendanceId);
    if (!persistedAttendance || persistedAttendance.status !== 'late') {
      throw new Error(`attendance ${attendanceId} did not survive restart: ${JSON.stringify(attendance)}`);
    }

    const reports = (await http.get(`/api/reports?sessionId=${sessionId}`)
      .set(auth(manager))
      .expect(200)).body as ReportRow[];
    const persistedReport = reports.find((row) => row.id === reportId);
    if (!persistedReport || persistedReport.status !== 'submitted' || persistedReport.approvalStatus !== 'approved' || persistedReport.approvedBy !== 4) {
      throw new Error(`report ${reportId} did not survive restart: ${JSON.stringify(reports)}`);
    }
    const persistedSession = (await http.get(`/api/schedule?from=${sessionDate}&to=${sessionDate}`)
      .set(auth(manager)).expect(200)).body.find((row: { id: number }) => row.id === sessionId);
    if (!persistedSession || persistedSession.instructorAttendance != null)
      throw new Error(`instructor attendance clear did not persist as NULL: ${JSON.stringify(persistedSession)}`);
    const restoredPreview = (await http.get(`/api/payouts/preview?instructorId=1&from=${sessionDate}&to=${sessionDate}`)
      .set(auth(ceo)).expect(200)).body;
    if (!restoredPreview.lines.some((line: { sessionId: number }) => line.sessionId === sessionId))
      throw new Error(`cleared session ${sessionId} was not payout eligible after restart`);

    await http.delete(`/api/schedule/${sessionId}`).set(auth(manager)).expect(200);
    await app.close();
  }

  {
    const app = await createTestApp();
    const http = request(app.getHttpServer());
    const manager = await login(http, 'manager');

    const attendance = (await http.get(`/api/attendance?sessionId=${sessionId}`)
      .set(auth(manager))
      .expect(200)).body as AttendanceRow[];
    if (attendance.some((row) => row.id === attendanceId)) {
      throw new Error(`attendance ${attendanceId} was still visible after session delete/restart`);
    }

    const reports = (await http.get(`/api/reports?sessionId=${sessionId}`)
      .set(auth(manager))
      .expect(200)).body as ReportRow[];
    if (reports.some((row) => row.id === reportId)) {
      throw new Error(`report ${reportId} was still visible after session delete/restart`);
    }
    await app.close();
  }

  console.log(JSON.stringify({ ok: true, sessionId, attendanceId, reportId, sessionDate }));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
