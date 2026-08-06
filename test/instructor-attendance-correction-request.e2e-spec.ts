import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { addDaysISO, createTestApp, E2E_APP_BOOT_TIMEOUT_MS, mondayISO } from './setup-app';

jest.setTimeout(30_000);
jest.retryTimes(0);

describe('[TBO-86F] 강사 출결 정정 승인 요청 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });
  const historicalDate = addDaysISO(mondayISO(), -500);
  let marker = 0;

  const createHeld = async () => {
    marker += 1;
    const startTime = `${String(marker).padStart(2, '0')}:00`;
    return (await http.post('/api/schedule/historical-completed').set(auth('manager')).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: historicalDate,
      startTime,
      durationMinutes: 50,
      kind: 'class',
      mode: 'online',
      topic: `TBO-86F ${marker}`,
      importReason: `출결 정정 요청 테스트 ${marker}`,
    }).expect(201)).body.row as { id: number; instructorAttendance: 'present'; status: 'held' };
  };

  const requestCorrection = async (sessionId: number, requested = 'late') =>
    (await http.post('/api/schedule-requests').set(auth('park_inst')).send({
      requestKind: 'instructor_attendance_correction',
      targetSessionId: sessionId,
      requestedInstructorAttendance: requested,
      requestReason: '실제 출결과 달라 정정을 요청합니다.',
    }).expect(201)).body.row as {
      id: number;
      status: 'pending' | 'approved' | 'rejected';
      instructorAttendanceBefore: string | null;
      requestedInstructorAttendance: string;
    };

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst', 'jung_inst']) {
      tokens[webId] = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  }, E2E_APP_BOOT_TIMEOUT_MS);

  afterAll(async () => { if (app) await app.close(); });

  it('강사 본인 회차의 before/requested를 snapshot하고 타 역할·타 강사·중복·직접 PUT을 차단한다', async () => {
    const session = await createHeld();
    await http.post('/api/schedule-requests').set(auth('manager')).send({
      requestKind: 'instructor_attendance_correction',
      targetSessionId: session.id,
      requestedInstructorAttendance: 'late',
      requestReason: '관리자는 강사 요청을 대신 만들 수 없습니다.',
    }).expect(403);
    await http.post('/api/schedule-requests').set(auth('jung_inst')).send({
      requestKind: 'instructor_attendance_correction',
      targetSessionId: session.id,
      requestedInstructorAttendance: 'late',
      requestReason: '타 강사 회차 요청은 차단되어야 합니다.',
    }).expect(403);
    await http.post('/api/schedule-requests').set(auth('park_inst')).send({
      requestKind: 'instructor_attendance_correction',
      targetSessionId: session.id,
      requestedInstructorAttendance: 'present',
      requestReason: '같은 값 요청 차단',
    }).expect(400);

    const correction = await requestCorrection(session.id);
    expect(correction).toMatchObject({
      status: 'pending',
      instructorAttendanceBefore: 'present',
      requestedInstructorAttendance: 'late',
    });
    const duplicate = await http.post('/api/schedule-requests').set(auth('park_inst')).send({
      requestKind: 'instructor_attendance_correction',
      targetSessionId: session.id,
      requestedInstructorAttendance: 'absent',
      requestReason: '중복 대기 요청 차단',
    }).expect(409);
    expect(duplicate.body).toMatchObject({ code: 'ATTENDANCE_CORRECTION_ALREADY_PENDING', requestId: correction.id });
    await http.put(`/api/schedule/${session.id}/instructor-attendance`).set(auth('park_inst'))
      .send({ status: 'late' }).expect(403);
  });

  it('회계 영향 미리보기 ACK 뒤 요청·출결·파생 상태·감사를 원자 승인하고 신청자 조회에 반영한다', async () => {
    const session = await createHeld();
    const report = (await http.post('/api/reports').set(auth('park_inst')).send({
      sessionId: session.id,
      studentId: 1,
      content: '출결 정정 승인 회계 영향 검증',
    }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/submit`).set(auth('park_inst')).send({}).expect(201);
    await http.post(`/api/reports/${report.id}/approve`).set(auth('admin')).send({}).expect(201);
    const correction = await requestCorrection(session.id);

    const preview = await http.post(`/api/schedule-requests/${correction.id}/approve`)
      .set(auth('manager')).expect(409);
    expect(preview.body).toMatchObject({ code: 'ACCOUNTING_IMPACT_ACK_REQUIRED' });
    expect(preview.body.impactHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await http.get(`/api/schedule/${session.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorAttendance: 'present', status: 'held' });

    await http.post(`/api/schedule-requests/${correction.id}/approve`).set(auth('manager')).query({
      acknowledgeAccountingImpact: 'true',
      expectedAccountingImpactHash: preview.body.impactHash,
    }).expect(201);
    expect((await http.get(`/api/schedule/${session.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorAttendance: 'late', status: 'held' });
    const own = (await http.get('/api/schedule-requests').set(auth('park_inst')).expect(200)).body;
    expect(own).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: correction.id, status: 'approved', requestReason: '실제 출결과 달라 정정을 요청합니다.' }),
    ]));

    const sessionAudit = (await http.get('/api/audit').set(auth('admin')).query({
      entity: 'class_sessions', entityId: session.id,
    }).expect(200)).body;
    expect(sessionAudit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'update', reason: `강사 출결 정정 요청 #${correction.id} 승인` }),
    ]));
    const requestAudit = (await http.get('/api/audit').set(auth('admin')).query({
      entity: 'schedule_requests', entityId: correction.id,
    }).expect(200)).body;
    expect(requestAudit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'approve' }),
    ]));
  });

  it('요청 뒤 출결이 바뀌면 stale 409로 보존하고 반려 사유와 신청자 결과를 남긴다', async () => {
    const session = await createHeld();
    const correction = await requestCorrection(session.id);
    const directPreview = await http.put(`/api/schedule/${session.id}/instructor-attendance`).set(auth('manager'))
      .send({ status: 'absent' }).expect(409);
    expect(directPreview.body).toMatchObject({ code: 'ACCOUNTING_IMPACT_ACK_REQUIRED' });
    await http.put(`/api/schedule/${session.id}/instructor-attendance`).set(auth('manager'))
      .send({
        status: 'absent',
        acknowledgeAccountingImpact: true,
        expectedAccountingImpactHash: directPreview.body.impactHash,
      }).expect(200);

    const stale = await http.post(`/api/schedule-requests/${correction.id}/approve`)
      .set(auth('manager')).expect(409);
    expect(stale.body).toMatchObject({
      code: 'REQUEST_TARGET_STALE',
      expectedInstructorAttendance: 'present',
      currentInstructorAttendance: 'absent',
    });
    await http.post(`/api/schedule-requests/${correction.id}/reject`).set(auth('manager'))
      .send({}).expect(400);
    await http.post(`/api/schedule-requests/${correction.id}/reject`).set(auth('manager'))
      .send({ reason: '관리자가 이미 실제 결석으로 정정했습니다.' }).expect(201);
    expect((await http.get(`/api/schedule/${session.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorAttendance: 'absent' });
    const own = (await http.get('/api/schedule-requests').set(auth('park_inst')).expect(200)).body;
    expect(own).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: correction.id,
        status: 'rejected',
        reason: '관리자가 이미 실제 결석으로 정정했습니다.',
      }),
    ]));
  });

  it('승인 audit 실패는 request/session/status/audit를 모두 rollback한다', async () => {
    const session = await createHeld();
    const correction = await requestCorrection(session.id);
    const audit = app.get(AuditService);
    const original = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (entry) => {
      if (entry.entity === 'schedule_requests' && entry.action === 'approve' && entry.entityId === correction.id) {
        throw new Error('injected attendance correction approval audit failure');
      }
      return original(entry);
    });
    await http.post(`/api/schedule-requests/${correction.id}/approve`).set(auth('manager')).expect(500);
    spy.mockRestore();

    expect((await http.get(`/api/schedule/${session.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorAttendance: 'present', status: 'held' });
    const pending = (await http.get('/api/schedule-requests').set(auth('manager'))
      .query({ status: 'pending' }).expect(200)).body;
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: correction.id, status: 'pending' }),
    ]));
    const sessionAudit = (await http.get('/api/audit').set(auth('admin')).query({
      entity: 'class_sessions', entityId: session.id,
    }).expect(200)).body as Array<{ reason?: string }>;
    expect(sessionAudit.some((row) => row.reason === `강사 출결 정정 요청 #${correction.id} 승인`)).toBe(false);
  });

  it('동시 승인 두 건 중 하나만 성공하고 출결·승인 audit도 한 번만 남긴다', async () => {
    const session = await createHeld();
    const correction = await requestCorrection(session.id);
    const responses = await Promise.all([
      http.post(`/api/schedule-requests/${correction.id}/approve`).set(auth('manager')),
      http.post(`/api/schedule-requests/${correction.id}/approve`).set(auth('manager')),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
    expect((await http.get(`/api/schedule/${session.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorAttendance: 'late' });
    const requestAudit = (await http.get('/api/audit').set(auth('admin')).query({
      entity: 'schedule_requests', entityId: correction.id,
    }).expect(200)).body as Array<{ action: string }>;
    expect(requestAudit.filter((row) => row.action === 'approve')).toHaveLength(1);
  });
});
