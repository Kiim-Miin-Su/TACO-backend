import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CalendarUnitOfWork } from '../src/database/calendar-unit-of-work.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { ClassSessionsStore } from '../src/modules/schedule/class-sessions.store';
import { teachingMinutesOf } from '../src/modules/schedule/session-accounting.policy';
import { addDaysISO, createTestApp, mondayISO } from './setup-app';

describe('report approve vs session terminal transition (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let adminToken = '';
  const pastDate = addDaysISO(mondayISO(), -14);
  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    adminToken = (await http.post('/api/auth/login')
      .send({ webId: 'admin', password: 'demo1234' })
      .expect(201)).body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  const createSubmittedReport = async (startTime: string): Promise<{ sessionId: number; reportId: number }> => {
    const sessionId = Number((await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: pastDate,
      startTime,
      durationMinutes: 60,
      force: true,
    }).expect(201)).body.row.id);
    const reportId = Number((await http.post('/api/reports').set(auth()).send({
      sessionId,
      studentId: 1,
      content: `경합 검증 ${startTime}`,
    }).expect(201)).body.id);
    return { sessionId, reportId };
  };

  const readback = async (sessionId: number, reportId: number) => {
    const session = await app.get(ClassSessionsStore).findByIdDb(sessionId);
    const report = (await http.get(`/api/reports/${reportId}`).set(auth()).expect(200)).body as {
      approvalStatus: string;
    };
    const reportApproveAudits = await app.get(AuditService).list({
      entity: 'session_reports',
      entityId: reportId,
      limit: 100,
    });
    const sessionStatusAudits = await app.get(AuditService).list({
      entity: 'class_sessions',
      entityId: sessionId,
      limit: 100,
    });
    return {
      session,
      report,
      reportApproveAudits: reportApproveAudits.filter((row) => row.action === 'approve'),
      sessionStatusAudits: sessionStatusAudits.filter((row) => row.action === 'update'),
    };
  };

  it.each(['canceled', 'no_show'] as const)(
    '%s가 먼저 확정되면 뒤늦은 approve는 409이고 보고서/시수/audit가 변하지 않는다',
    async (terminalStatus) => {
      const { sessionId, reportId } = await createSubmittedReport(terminalStatus === 'canceled' ? '06:00' : '07:00');

      await http.patch(`/api/schedule/${sessionId}`).set(auth()).send({
        status: terminalStatus,
        force: true,
      }).expect(200);
      const lockSpy = jest.spyOn(app.get(CalendarUnitOfWork), 'lockTargets');
      const rejected = await http.post(`/api/reports/${reportId}/approve`).set(auth()).expect(409);
      expect(lockSpy).toHaveBeenCalledWith(expect.arrayContaining([
        { kind: 'session', id: sessionId },
        { kind: 'report', id: reportId },
      ]));
      lockSpy.mockRestore();
      expect(rejected.body).toMatchObject({
        code: 'SESSION_TERMINAL',
        sessionId,
        sessionStatus: terminalStatus,
      });

      const after = await readback(sessionId, reportId);
      expect(after.session?.status).toBe(terminalStatus);
      expect(after.report?.approvalStatus).toBe('submitted');
      expect(after.reportApproveAudits).toHaveLength(0);
      expect(after.session && teachingMinutesOf(after.session)).toBe(0);
    },
  );

  it('정상 approve는 같은 transaction에서 submitted→approved, scheduled→held, 시수 60분, audit를 확정한다', async () => {
    const { sessionId, reportId } = await createSubmittedReport('07:30');
    const before = await readback(sessionId, reportId);
    expect(before.session?.status).toBe('scheduled');
    expect(before.report?.approvalStatus).toBe('submitted');
    expect(before.session && teachingMinutesOf(before.session)).toBe(0);

    await http.post(`/api/reports/${reportId}/approve`).set(auth()).expect(201);

    const after = await readback(sessionId, reportId);
    expect(after.session?.status).toBe('held');
    expect(after.report?.approvalStatus).toBe('approved');
    expect(after.session && teachingMinutesOf(after.session)).toBe(60);
    expect(after.reportApproveAudits).toHaveLength(1);
    expect(after.sessionStatusAudits).toHaveLength(1);
  });

  it.each([
    ['canceled', '08:00'],
    ['no_show', '08:30'],
  ] as const)(
    'approve와 %s 경합은 직렬화되고 terminal session이 held로 부활하지 않는다',
    async (terminalStatus, startTime) => {
      const { sessionId, reportId } = await createSubmittedReport(startTime);

      const [terminalResponse, approveResponse] = await Promise.all([
        http.patch(`/api/schedule/${sessionId}`).set(auth()).send({
          status: terminalStatus,
          force: true,
          acknowledgeAccountingImpact: true,
        }),
        http.post(`/api/reports/${reportId}/approve`).set(auth()),
      ]);

      expect(terminalResponse.status).toBe(200);
      expect([201, 409]).toContain(approveResponse.status);

      const after = await readback(sessionId, reportId);
      expect(after.session?.status).toBe(terminalStatus);
      expect(['submitted', 'approved']).toContain(after.report?.approvalStatus);
      expect(after.reportApproveAudits).toHaveLength(after.report?.approvalStatus === 'approved' ? 1 : 0);
      expect(after.session && teachingMinutesOf(after.session)).toBe(0);
    },
  );

  it('approve 중 audit 실패는 report CAS·자동 held·audit를 한 transaction으로 롤백한다', async () => {
    const { sessionId, reportId } = await createSubmittedReport('09:00');
    const audit = app.get(AuditService);
    const logSpy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected report approve audit failure'));

    await http.post(`/api/reports/${reportId}/approve`).set(auth()).expect(500);
    logSpy.mockRestore();

    const after = await readback(sessionId, reportId);
    expect(after.session?.status).toBe('scheduled');
    expect(after.report?.approvalStatus).toBe('submitted');
    expect(after.reportApproveAudits).toHaveLength(0);
    expect(after.sessionStatusAudits).toHaveLength(0); // auto-held update audit도 같은 tx에서 롤백
    expect(after.session && teachingMinutesOf(after.session)).toBe(0);
  });
});
