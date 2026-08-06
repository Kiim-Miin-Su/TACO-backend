import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  completeSessionByAttendance,
  createTestApp,
  E2E_APP_BOOT_TIMEOUT_MS,
  sudoAuthHeaders,
} from './setup-app';

type ScheduleRow = {
  id: number;
  instructorId: number;
  seriesId?: number | null;
  sessionDate: string;
  startTime: string;
  durationMinutes: number;
  status: string;
  instructorAttendance?: string | null;
  attendanceRequired?: boolean;
  missingAttendance?: { instructor: boolean; studentIds: number[] };
  payoutId?: number | null;
};

type PayoutLine = {
  sessionId: number;
  durationMinutes: number;
  hourlyRate: number;
  amount: number;
};

describe('[TBO-85] 2026년 7월 스케줄 입력부터 정산까지 월요일 실사용 여정', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });
  const ceo = () => sudoAuthHeaders(app, tokens.admin);

  const FROM = '2026-07-01';
  const TO = '2026-07-31';
  const INSTRUCTOR_ID = 1;
  const STUDENT_ID = 1;
  const COURSE_ID = 10;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'prof_admin', 'manager', 'park_inst']) {
      tokens[webId] = (
        await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)
      ).body.accessToken;
    }
  }, E2E_APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await app.close();
  });

  // This is one monthly ledger journey. A per-test retry could reuse a partially paid payout.
  jest.retryTimes(0);

  it('weekly/custom CRUD -> instructor request -> attendance/report -> worksheet/payout/audit', async () => {
    await http.post('/api/schedule').set(auth('park_inst')).send({
      courseId: COURSE_ID,
      instructorId: INSTRUCTOR_ID,
      studentIds: [STUDENT_ID],
      sessionDate: '2026-07-05',
      startTime: '09:00',
      durationMinutes: 60,
    }).expect(403);

    const weekly = (await http.post('/api/schedule/series').set(auth('manager')).send({
      courseId: COURSE_ID,
      instructorId: INSTRUCTOR_ID,
      studentIds: [STUDENT_ID],
      repeat: { kind: 'weekly', weekdays: [0], startsOn: '2026-07-05', endsOn: '2026-07-26' },
      startTime: '09:00',
      endTime: '10:00',
      mode: 'online',
      topic: 'TBO85-UAT-7월 주간 수업',
    }).expect(201)).body as {
      series: { id: number };
      rows: ScheduleRow[];
      conflicts: unknown[];
    };
    expect(weekly.conflicts).toEqual([]);
    expect(weekly.rows.map((row) => row.sessionDate)).toEqual([
      '2026-07-05',
      '2026-07-12',
      '2026-07-19',
      '2026-07-26',
    ]);

    const custom = (await http.post('/api/schedule/series').set(auth('manager')).send({
      courseId: COURSE_ID,
      instructorId: INSTRUCTOR_ID,
      studentIds: [STUDENT_ID],
      repeat: { kind: 'custom', weekdays: [6], startsOn: '2026-07-04', endsOn: '2026-07-11' },
      startTime: '06:00',
      endTime: '07:00',
      mode: 'online',
      topic: 'TBO85-UAT-7월 custom 수업',
    }).expect(201)).body as { series: { id: number }; rows: ScheduleRow[] };
    expect(custom.rows.map((row) => row.sessionDate)).toEqual(['2026-07-04', '2026-07-11']);

    const deletedCustomId = custom.rows[1].id;
    await http.delete(`/api/schedule/${deletedCustomId}`).set(auth('manager')).expect(200);
    const directUpdatedId = custom.rows[0].id;
    await http.patch(`/api/schedule/${directUpdatedId}`).set(auth('manager')).send({
      startTime: '06:30',
      endTime: '07:30',
      topic: 'TBO85-UAT-custom 직접 수정',
    }).expect(200);

    const targetId = weekly.rows[0].id;
    const pending = (await http.post('/api/schedule-requests').set(auth('park_inst')).send({
      requestKind: 'session_update',
      targetSessionId: targetId,
      sessionDate: '2026-07-05',
      startTime: '10:30',
      endTime: '11:30',
      requestReason: '7월 실제 입력 리허설 시간 변경',
      scope: 'this',
    }).expect(201)).body.row as { id: number; status: string };
    expect(pending.status).toBe('pending');

    const managerPending = (await http.get('/api/schedule-requests?status=pending')
      .set(auth('manager')).expect(200)).body as Array<{ id: number }>;
    expect(managerPending).toEqual(expect.arrayContaining([expect.objectContaining({ id: pending.id })]));
    await http.post(`/api/schedule-requests/${pending.id}/approve`).set(auth('park_inst')).expect(403);
    const approved = (await http.post(`/api/schedule-requests/${pending.id}/approve`)
      .set(auth('manager')).expect(201)).body;
    expect(approved.request).toMatchObject({ id: pending.id, status: 'approved' });

    const ceoPending = (await http.get('/api/schedule-requests?status=pending')
      .set(auth('admin')).expect(200)).body as Array<{ id: number }>;
    expect(ceoPending.some((row) => row.id === pending.id)).toBe(false);
    const requesterResult = (await http.get('/api/schedule-requests?status=approved')
      .set(auth('park_inst')).expect(200)).body as Array<{ id: number; requestReason?: string }>;
    expect(requesterResult).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pending.id, requestReason: '7월 실제 입력 리허설 시간 변경' }),
    ]));

    const activeIds = [...weekly.rows.map((row) => row.id), directUpdatedId];
    const monthRows = (await http.get(`/api/schedule?from=${FROM}&to=${TO}`)
      .set(auth('manager')).expect(200)).body as ScheduleRow[];
    const createdRows = monthRows.filter((row) => activeIds.includes(row.id));
    expect(createdRows).toHaveLength(5);
    expect(createdRows.find((row) => row.id === targetId)).toMatchObject({
      startTime: '10:30',
      status: 'scheduled',
      instructorAttendance: null,
      attendanceRequired: true,
      missingAttendance: { instructor: true, studentIds: [STUDENT_ID] },
    });
    expect(createdRows.find((row) => row.id === directUpdatedId)).toMatchObject({ startTime: '06:30' });
    expect(monthRows.some((row) => row.id === deletedCustomId)).toBe(false);

    const instructorRows = (await http.get(`/api/schedule?from=${FROM}&to=${TO}`)
      .set(auth('park_inst')).expect(200)).body as ScheduleRow[];
    expect(instructorRows.filter((row) => activeIds.includes(row.id))).toHaveLength(5);
    expect(instructorRows.every((row) => row.instructorId === INSTRUCTOR_ID)).toBe(true);

    await http.put(`/api/schedule/${targetId}/instructor-attendance`)
      .set(auth('manager')).send({ status: 'present' }).expect(200);
    await http.put(`/api/schedule/${targetId}/instructor-attendance`)
      .set(auth('prof_admin')).send({ status: 'present' }).expect(200);
    await http.put(`/api/schedule/${targetId}/instructor-attendance`)
      .set(auth('park_inst')).send({ status: 'present' }).expect(403);

    const reportIds: number[] = [];
    for (const sessionId of activeIds) {
      await completeSessionByAttendance(http, ceo(), sessionId, [STUDENT_ID]);
      const report = (await http.post('/api/reports').set(auth('park_inst')).send({
        sessionId,
        studentId: STUDENT_ID,
        content: '7월 Writing 수업 내용과 학생 이해도를 기록했습니다.',
        progressPage: 'Vocab #6 PDF 문장 만들기',
        homework: 'Vocab #6 문장 완성과 단어 암기',
        status: 'draft',
      }).expect(201)).body as { id: number };
      reportIds.push(report.id);
      await http.post(`/api/reports/${report.id}/submit`).set(auth('park_inst')).expect(201);
      await http.post(`/api/reports/${report.id}/approve`).set(auth('manager')).expect(201);
    }

    const joinedReports = (await http.get(`/api/reports?sessionId=${targetId}`)
      .set(auth('manager')).expect(200)).body as Array<{
        id: number;
        progressPage?: string;
        homework?: string;
        approvalStatus?: string;
        context?: {
          student: { id: number; name: string };
          session: { id: number; sessionDate: string };
          course: { id: number; name: string };
          instructor: { id: number; name: string };
        };
      }>;
    expect(joinedReports).toEqual(expect.arrayContaining([expect.objectContaining({
      id: reportIds[0],
      progressPage: 'Vocab #6 PDF 문장 만들기',
      homework: 'Vocab #6 문장 완성과 단어 암기',
      approvalStatus: 'approved',
      context: expect.objectContaining({
        student: expect.objectContaining({ id: STUDENT_ID, name: expect.any(String) }),
        session: expect.objectContaining({ id: targetId, sessionDate: '2026-07-05' }),
        course: expect.objectContaining({ id: COURSE_ID, name: expect.any(String) }),
        instructor: expect.objectContaining({ id: INSTRUCTOR_ID, name: expect.any(String) }),
      }),
    })]));

    const heldRows = (await http.get(`/api/schedule?from=${FROM}&to=${TO}`)
      .set(auth('manager')).expect(200)).body as ScheduleRow[];
    expect(heldRows.filter((row) => activeIds.includes(row.id)).every((row) => (
      row.status === 'held'
      && row.instructorAttendance === 'present'
      && row.attendanceRequired === false
      && row.missingAttendance?.instructor === false
      && row.missingAttendance.studentIds.length === 0
    ))).toBe(true);

    await http.get(`/api/payouts/preview?instructorId=${INSTRUCTOR_ID}&from=${FROM}&to=${TO}`)
      .set(auth('manager')).expect(403);
    await http.get(`/api/payouts/preview?instructorId=${INSTRUCTOR_ID}&from=${FROM}&to=${TO}`)
      .set(auth('prof_admin')).expect(403);

    const preview = (await http.get('/api/payouts/preview').query({
      instructorId: INSTRUCTOR_ID,
      from: FROM,
      to: TO,
    }).set(ceo()).expect(200)).body as { lines: PayoutLine[] };
    const previewLines = preview.lines.filter((line) => activeIds.includes(line.sessionId));
    expect(previewLines).toHaveLength(5);
    expect(previewLines).toEqual(expect.arrayContaining(activeIds.map((sessionId) => expect.objectContaining({
      sessionId,
      durationMinutes: 60,
      hourlyRate: 50000,
      amount: 50000,
    }))));

    const worksheet = (await http.get('/api/payouts/worksheet').query({
      instructorId: INSTRUCTOR_ID,
      from: FROM,
      to: TO,
    }).set(ceo()).expect(200)).body as { rows: Array<{ sessionId: number; pricing: { effectiveAmount: number } }> };
    expect(worksheet.rows.filter((row) => activeIds.includes(row.sessionId))).toEqual(
      expect.arrayContaining(activeIds.map((sessionId) => expect.objectContaining({
        sessionId,
        pricing: expect.objectContaining({ effectiveAmount: 50000 }),
      }))),
    );

    const payout = (await http.post('/api/payouts/generate').set(ceo()).send({
      instructorId: INSTRUCTOR_ID,
      from: FROM,
      to: TO,
    }).expect(201)).body as { id: number; lines: PayoutLine[]; computedAmount: number; amount: number };
    const payoutLines = payout.lines.filter((line) => activeIds.includes(line.sessionId));
    expect(payoutLines).toHaveLength(5);
    expect(payoutLines).toEqual(previewLines);
    expect(payout.computedAmount).toBe(payout.lines.reduce((sum, line) => sum + line.amount, 0));
    expect(payout.amount).toBe(payout.computedAmount);

    await http.post(`/api/payouts/${payout.id}/confirm`).set(ceo()).expect(201);
    const paid = (await http.post(`/api/payouts/${payout.id}/pay`).set(ceo()).expect(201)).body;
    expect(paid.payout).toMatchObject({ id: payout.id, status: 'paid' });
    expect(paid.transaction).toMatchObject({
      payoutId: payout.id,
      category: 'instructor_payout',
      direction: 'out',
      amount: payout.amount,
    });

    const paidRows = (await http.get(`/api/schedule?from=${FROM}&to=${TO}`)
      .set(auth('admin')).expect(200)).body as ScheduleRow[];
    expect(paidRows.filter((row) => activeIds.includes(row.id)).every((row) => row.payoutId === payout.id)).toBe(true);

    const [sessionAudit, requestAudit, payoutAudit] = await Promise.all([
      http.get(`/api/audit?entity=class_sessions&entityId=${targetId}`).set(auth('admin')).expect(200),
      http.get(`/api/audit?entity=schedule_requests&entityId=${pending.id}`).set(auth('admin')).expect(200),
      http.get(`/api/audit?entity=instructor_payouts&entityId=${payout.id}`).set(auth('admin')).expect(200),
    ]);
    expect(sessionAudit.body.some((row: { action: string }) => ['create', 'update'].includes(row.action))).toBe(true);
    expect(requestAudit.body.some((row: { action: string }) => row.action === 'approve')).toBe(true);
    expect(payoutAudit.body.some((row: { action: string }) => row.action === 'status_change')).toBe(true);
    expect(reportIds).toHaveLength(5);
  });
});
