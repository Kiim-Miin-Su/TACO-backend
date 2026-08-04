import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import {
  attendanceCompletionHoldPatch,
  attendanceRequirementOf,
  hasSessionTemporalChange,
} from '../src/modules/schedule/session-temporal-transition.policy';
import { buildCohortIndex } from '../src/modules/schedule/session-participant.policy';
import { isPayoutLocked } from '../src/modules/schedule/session-accounting.policy';
import { addDaysISO, createTestApp, mondayISO } from './setup-app';

describe('[TBO-76 E] 시간 변경과 출결 자동 전이', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin: string;
  const auth = () => ({ Authorization: `Bearer ${admin}` });
  const past = addDaysISO(mondayISO(), -21);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });

  afterAll(async () => { await app.close(); });

  it('순수 정책: 시간 키·완결 뱃지·지급 완료 잠금이 단일 진실원이다', () => {
    const session = {
      id: 91,
      courseId: 10,
      studentIds: [1, 4],
      sessionDate: past,
      startTime: '08:00',
      durationMinutes: 60,
      status: 'scheduled' as const,
      instructorAttendance: 'present' as const,
    };
    const cohort = buildCohortIndex([]);
    expect(hasSessionTemporalChange(session, { ...session, startTime: '08:30' })).toBe(true);
    expect(attendanceRequirementOf(session, cohort, [{ studentId: 1 }], Date.now())).toEqual({
      attendanceRequired: true,
      missingAttendance: { instructor: false, studentIds: [4] },
    });
    expect(attendanceCompletionHoldPatch(session, cohort, [{ studentId: 1 }, { studentId: 4 }], Date.now()))
      .toEqual({ status: 'held' });
    expect(isPayoutLocked({ status: 'held', durationMinutes: 60, isPaid: true })).toBe(true);
  });

  it('순수 정책: 진행 중에는 출결이 완결돼도 held가 아니며 종료 뒤에만 전이한다', () => {
    const session = {
      id: 92,
      courseId: 10,
      studentIds: [1],
      sessionDate: '2026-07-29',
      startTime: '10:00',
      durationMinutes: 60,
      status: 'scheduled' as const,
      instructorAttendance: 'present' as const,
    };
    const cohort = buildCohortIndex([]);
    const during = Date.parse('2026-07-29T10:30:00+09:00');
    expect(attendanceCompletionHoldPatch(session, cohort, [{ studentId: 1 }], during)).toBeNull();
    expect(attendanceRequirementOf(session, cohort, [{ studentId: 1 }], during).attendanceRequired).toBe(false);
    const ended = Date.parse('2026-07-29T11:00:00+09:00');
    expect(attendanceCompletionHoldPatch(session, cohort, [{ studentId: 1 }], ended))
      .toEqual({ status: 'held' });
  });

  it('API: held 직접 생성·전이는 사실 불일치로 차단하고 세션·감사를 바꾸지 않는다', async () => {
    const audit = app.get(AuditService);
    const before = await audit.list({ entity: 'class_sessions', limit: 500 });
    const future = addDaysISO(mondayISO(), 35);
    const deniedCreate = await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: future,
      startTime: '10:00',
      durationMinutes: 60,
      status: 'held',
      force: true,
    }).expect(400);
    expect(deniedCreate.body).toMatchObject({ code: 'SESSION_STATUS_FACT_MISMATCH' });
    expect((await audit.list({ entity: 'class_sessions', limit: 500 })).length).toBe(before.length);

    const created = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: future,
      startTime: '12:00',
      durationMinutes: 60,
      force: true,
    }).expect(201)).body.row as { id: number };
    const afterCreateAudit = await audit.list({ entity: 'class_sessions', entityId: created.id, limit: 20 });
    const deniedPatch = await http.patch(`/api/schedule/${created.id}`).set(auth())
      .send({ status: 'held', force: true }).expect(400);
    expect(deniedPatch.body).toMatchObject({ code: 'SESSION_STATUS_FACT_MISMATCH' });
    expect((await http.get(`/api/schedule/${created.id}`).set(auth()).expect(200)).body.status).toBe('scheduled');
    expect(await audit.list({ entity: 'class_sessions', entityId: created.id, limit: 20 }))
      .toHaveLength(afterCreateAudit.length);
  });

  it('완료 수업 시간 이동은 확인 후 출결을 비우고 보고서를 보존하며 재입력을 요구한다', async () => {
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: past,
      startTime: '14:00',
      durationMinutes: 60,
      force: true,
    }).expect(201)).body.row as { id: number };
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: session.id, studentId: 1, status: 'present' }).expect(200);
    await http.put(`/api/schedule/${session.id}/instructor-attendance`).set(auth())
      .send({ status: 'present' }).expect(200);
    const report = (await http.post('/api/reports').set(auth())
      .send({ sessionId: session.id, studentId: 1, content: '시간 변경 후에도 보존할 보고서' })
      .expect(201)).body as { id: number };
    await http.post(`/api/reports/${report.id}/submit`).set(auth()).expect(201);
    await http.post(`/api/reports/${report.id}/approve`).set(auth()).expect(201);

    const beforeManualRollback = await http.get(`/api/schedule/${session.id}`).set(auth()).expect(200);
    const deniedRollback = await http.patch(`/api/schedule/${session.id}`).set(auth())
      .send({ status: 'scheduled', force: true }).expect(400);
    expect(deniedRollback.body).toMatchObject({ code: 'SESSION_STATUS_FACT_MISMATCH' });
    expect((await http.get(`/api/schedule/${session.id}`).set(auth()).expect(200)).body)
      .toMatchObject({
        status: beforeManualRollback.body.status,
        instructorAttendance: beforeManualRollback.body.instructorAttendance,
      });

    const proposed = {
      sessionDate: past,
      startTime: '16:00',
      durationMinutes: 60,
      force: true,
    };
    const blocked = await http.patch(`/api/schedule/${session.id}`).set(auth()).send(proposed).expect(409);
    expect(blocked.body).toMatchObject({
      code: 'ACCOUNTING_IMPACT_ACK_REQUIRED',
      impact: {
        before: { teachingMinutes: 60, payoutEligibleMinutes: 60 },
        after: { teachingMinutes: 0, payoutEligibleMinutes: 0 },
      },
    });
    const changed = (await http.patch(`/api/schedule/${session.id}`).set(auth()).send({
      ...proposed,
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(200)).body.row;
    expect(changed).toMatchObject({
      status: 'scheduled',
      instructorAttendance: null,
      attendanceRequired: true,
      missingAttendance: { instructor: true, studentIds: [1] },
    });
    expect((await http.get(`/api/attendance?sessionId=${session.id}`).set(auth()).expect(200)).body).toEqual([]);
    expect((await http.get(`/api/reports?sessionId=${session.id}`).set(auth()).expect(200)).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: report.id, approvalStatus: 'approved' })]));
  });

  it('출결 초기화 감사 실패 시 세션 시간과 출결을 함께 롤백한다', async () => {
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: past,
      startTime: '18:00',
      durationMinutes: 60,
      force: true,
    }).expect(201)).body.row as { id: number };
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: session.id, studentId: 1, status: 'present' }).expect(200);

    const audit = app.get(AuditService);
    const originalLog = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (entry) => {
      if (entry.entity === 'attendance' && entry.action === 'delete') throw new Error('injected attendance reset audit failure');
      return originalLog(entry);
    });
    try {
      await http.patch(`/api/schedule/${session.id}`).set(auth()).send({
        sessionDate: past,
        startTime: '19:00',
        durationMinutes: 60,
        force: true,
      }).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect((await http.get(`/api/schedule/${session.id}`).set(auth()).expect(200)).body.startTime).toBe('18:00');
    expect((await http.get(`/api/attendance?sessionId=${session.id}`).set(auth()).expect(200)).body)
      .toEqual(expect.arrayContaining([expect.objectContaining({ studentId: 1, status: 'present' })]));
  });

  it('취소·결강·보강 종결 수업 시간 변경은 409로 차단한다', async () => {
    for (const status of ['canceled', 'no_show', 'makeup'] as const) {
      const session = (await http.post('/api/schedule').set(auth()).send({
        courseId: 10,
        instructorId: 1,
        studentIds: [1],
        sessionDate: addDaysISO(past, status === 'canceled' ? 1 : status === 'no_show' ? 2 : 3),
        startTime: '20:00',
        durationMinutes: 60,
        status,
        force: true,
      }).expect(201)).body.row as { id: number };
      const response = await http.patch(`/api/schedule/${session.id}`).set(auth()).send({
        startTime: '21:00',
        durationMinutes: 60,
        force: true,
      }).expect(409);
      expect(response.body).toMatchObject({ code: 'TERMINAL_SESSION_TIME_CHANGE', sessionId: session.id });
    }
  });

  it('반복 scope=all 시간 변경은 모든 회차 출결을 한 transaction에서 초기화한다', async () => {
    const seriesStart = addDaysISO(past, -7);
    const weekday = new Date(`${seriesStart}T00:00:00Z`).getUTCDay();
    const made = (await http.post('/api/schedule/series').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      startTime: '06:00',
      durationMinutes: 60,
      repeat: {
        kind: 'weekly',
        weekdays: [weekday],
        startsOn: seriesStart,
        endsOn: addDaysISO(seriesStart, 7),
      },
      force: true,
    }).expect(201)).body as { rows: Array<{ id: number }>; series: { version: number } };
    expect(made.rows).toHaveLength(2);
    for (const row of made.rows) {
      await http.put('/api/attendance').set(auth())
        .send({ sessionId: row.id, studentId: 1, status: 'present' }).expect(200);
      await http.put(`/api/schedule/${row.id}/instructor-attendance`).set(auth())
        .send({ status: 'present' }).expect(200);
    }
    const body = {
      startTime: '07:00',
      durationMinutes: 60,
      scope: 'all',
      expectedSeriesVersion: made.series.version,
      force: true,
    };
    const blocked = await http.patch(`/api/schedule/${made.rows[0].id}`).set(auth()).send(body).expect(409);
    const applied = await http.patch(`/api/schedule/${made.rows[0].id}`).set(auth()).send({
      ...body,
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(200);
    expect(applied.body.updated).toBe(2);
    for (const row of made.rows) {
      expect((await http.get(`/api/schedule/${row.id}`).set(auth()).expect(200)).body)
        .toMatchObject({ startTime: '07:00', status: 'scheduled', instructorAttendance: null, attendanceRequired: true });
      expect((await http.get(`/api/attendance?sessionId=${row.id}`).set(auth()).expect(200)).body).toEqual([]);
    }
  });

  it('강사 변경 요청 승인도 직접 수정과 같은 회계 확인·출결 초기화 명령을 사용한다', async () => {
    const requestDay = addDaysISO(past, -1);
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: requestDay,
      startTime: '09:00',
      durationMinutes: 60,
      force: true,
    }).expect(201)).body.row as { id: number };
    await http.put('/api/attendance').set(auth())
      .send({ sessionId: session.id, studentId: 1, status: 'present' }).expect(200);
    await http.put(`/api/schedule/${session.id}/instructor-attendance`).set(auth())
      .send({ status: 'present' }).expect(200);
    const instructorToken = (await http.post('/api/auth/login')
      .send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    const requestRow = (await http.post('/api/schedule-requests')
      .set({ Authorization: `Bearer ${instructorToken}` })
      .send({
        requestKind: 'session_update',
        targetSessionId: session.id,
        sessionDate: requestDay,
        startTime: '10:00',
        endTime: '11:00',
        requestReason: 'TBO-76 승인 경로 전이 검증',
        scope: 'this',
      }).expect(201)).body.row as { id: number };
    const blocked = await http.post(`/api/schedule-requests/${requestRow.id}/approve`).set(auth()).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    await http.post(`/api/schedule-requests/${requestRow.id}/approve`).set(auth()).query({
      acknowledgeAccountingImpact: 'true',
      expectedAccountingImpactHash: blocked.body.impactHash,
      forceConflicts: 'true',
    }).expect(201);
    expect((await http.get(`/api/schedule/${session.id}`).set(auth()).expect(200)).body)
      .toMatchObject({ startTime: '10:00', status: 'scheduled', instructorAttendance: null, attendanceRequired: true });
    expect((await http.get(`/api/attendance?sessionId=${session.id}`).set(auth()).expect(200)).body).toEqual([]);
  });
});
