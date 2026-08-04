import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  addDaysISO,
  createTestApp,
  E2E_APP_BOOT_TIMEOUT_MS,
  mondayISO,
  sudoAuthHeaders,
} from './setup-app';

jest.setTimeout(20000);
jest.retryTimes(0);

describe('[TBO-83E] 강사 출결 전용 command (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => sudoAuthHeaders(app, tokens[who]);
  const sessionDate = addDaysISO(mondayISO(), -35);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  }, E2E_APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('구 POST alias와 범용 schedule PATCH 출결 payload는 fail-closed다', async () => {
    await http.post('/api/schedule/1/instructor-attendance').set(as('admin'))
      .send({ status: 'present' }).expect(404);
    await http.patch('/api/schedule/1').set(as('admin'))
      .send({ instructorAttendance: 'present' }).expect(400);
    await http.patch('/api/schedule/1').set(as('admin'))
      .send({ clearInstructorAttendance: true }).expect(400);
  });

  it('set/update/clear가 권한·ACK·held 역전이·감사를 한 경로에서 보존한다', async () => {
    const created = (await http.post('/api/schedule').set(as('manager')).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate,
      startTime: '17:00',
      durationMinutes: 60,
      force: true,
    }).expect(201)).body.row as { id: number };

    await http.put('/api/attendance').set(as('admin'))
      .send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);

    await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(as('manager'))
      .send({ status: 'present' }).expect(403);
    await http.delete(`/api/schedule/${created.id}/instructor-attendance`).set(as('manager'))
      .send({ reason: '권한 음성 검증' }).expect(403);

    const held = (await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin'))
      .send({ status: 'present' }).expect(200)).body.row;
    expect(held).toMatchObject({ status: 'held', instructorAttendance: 'present' });

    const report = (await http.post('/api/reports').set(as('park_inst')).send({
      sessionId: created.id,
      studentId: 1,
      content: '강사 출결 전용 명령 회계 영향 검증',
    }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/submit`).set(as('park_inst')).send({}).expect(201);
    await http.post(`/api/reports/${report.id}/approve`).set(as('admin')).send({}).expect(201);

    const blockedUpdate = await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin'))
      .send({ status: 'late' }).expect(409);
    expect(blockedUpdate.body).toMatchObject({ code: 'ACCOUNTING_IMPACT_ACK_REQUIRED' });
    expect(blockedUpdate.body.impactHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body)
      .toMatchObject({ status: 'held', instructorAttendance: 'present' });

    await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin')).send({
      status: 'late',
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blockedUpdate.body.impactHash,
    }).expect(200);

    await http.delete(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin'))
      .send({}).expect(400);
    const blockedClear = await http.delete(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin'))
      .send({ reason: '오입력 정정' }).expect(409);
    expect(blockedClear.body).toMatchObject({ code: 'ACCOUNTING_IMPACT_ACK_REQUIRED' });

    const acknowledgedClear = await http.delete(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin')).send({
      reason: '오입력 정정',
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blockedClear.body.impactHash,
    });
    if (acknowledgedClear.status !== 200) {
      throw new Error(`강사 출결 clear ACK 실패: status=${acknowledgedClear.status} body=${JSON.stringify(acknowledgedClear.body)}`);
    }
    const cleared = acknowledgedClear.body.row;
    expect(cleared).toMatchObject({ status: 'scheduled', instructorAttendance: null });

    const audit = (await http.get(`/api/audit?entity=class_sessions&entityId=${created.id}`)
      .set(as('admin')).expect(200)).body as Array<{
        reason?: string;
        changes?: Record<string, { before?: unknown; after?: unknown }>;
      }>;
    const clearAudit = audit.find((row) => row.reason === '오입력 정정');
    expect(clearAudit?.changes?.instructorAttendance).toEqual({ before: 'late', after: null });
    expect(clearAudit?.changes?.status).toEqual({ before: 'held', after: 'scheduled' });
    expect(clearAudit?.changes?.accountingImpactAcknowledgement?.after).toMatchObject({
      hash: blockedClear.body.impactHash,
    });

    await http.delete(`/api/schedule/${created.id}`).set(as('manager')).expect(200);
  });
});
