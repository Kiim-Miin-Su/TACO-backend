import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { createTestApp } from './setup-app';

describe('[TBO-86 G3] approved report revisions (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let managerToken = '';
  let instructorToken = '';
  const auth = (token = managerToken) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    managerToken = (await http.post('/api/auth/login')
      .send({ webId: 'manager', password: 'demo1234' }).expect(201)).body.accessToken;
    instructorToken = (await http.post('/api/auth/login')
      .send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });

  afterAll(async () => { await app.close(); });

  const approvedFixture = async (startTime: string, content: string) => {
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      sessionDate: '2096-08-06',
      startTime,
      durationMinutes: 60,
      studentIds: [1],
      force: true,
    }).expect(201)).body.row;
    const report = (await http.post('/api/reports').set(auth()).send({
      sessionId: session.id,
      studentId: 1,
      content,
      progressPage: '10p',
      homework: '문제 1-3',
      status: 'submitted',
    }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/approve`).set(auth()).send({}).expect(201);
    return (await http.get(`/api/reports/${report.id}`).set(auth()).expect(200)).body as {
      id: number;
      version: number;
      content: string;
      approvalStatus: string;
    };
  };

  it('manager concurrent edit is one-winner, appends exact before/after, and blocks instructor/stale input', async () => {
    const report = await approvedFixture('02:00', '승인 원문');
    expect(report).toMatchObject({ version: 1, approvalStatus: 'approved' });

    await http.post(`/api/reports/${report.id}/revise`).set(auth(instructorToken)).send({
      expectedVersion: 1, reason: '권한 없는 수정', content: '침범',
    }).expect(403);
    await http.post(`/api/reports/${report.id}/revise`).set(auth()).send({
      expectedVersion: 1, reason: '   ', content: '사유 없음',
    }).expect(400);

    const responses = await Promise.all([
      http.post(`/api/reports/${report.id}/revise`).set(auth()).send({
        expectedVersion: 1,
        reason: '첫 교정',
        content: '교정안 A',
        progressPage: '11p',
        homework: '',
      }),
      http.post(`/api/reports/${report.id}/revise`).set(auth()).send({
        expectedVersion: 1,
        reason: '동시 교정',
        content: '교정안 B',
        progressPage: '12p',
        homework: '다른 숙제',
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const after = (await http.get(`/api/reports/${report.id}`).set(auth()).expect(200)).body;
    expect(after.version).toBe(2);
    expect(after.approvalStatus).toBe('approved');
    const revisions = (await http.get(`/api/reports/${report.id}/revisions`).set(auth()).expect(200)).body;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      reportId: report.id,
      beforeVersion: 1,
      afterVersion: 2,
      beforeContent: '승인 원문',
      afterContent: after.content,
      editedBy: expect.any(Number),
      editedByName: expect.any(String),
    });
    expect(revisions[0].reason).toMatch(/교정/);

    const stale = await http.post(`/api/reports/${report.id}/revise`).set(auth()).send({
      expectedVersion: 1,
      reason: '오래된 화면',
      content: '덮어쓰기 시도',
    }).expect(409);
    expect(stale.body).toMatchObject({ code: 'REPORT_VERSION_STALE', currentVersion: 2 });
  });

  it('audit failure rolls back report and append-only revision together', async () => {
    const report = await approvedFixture('03:30', '롤백 원문');
    const auditSpy = jest.spyOn(app.get(AuditService), 'log')
      .mockRejectedValueOnce(new Error('injected report revision audit failure'));

    await http.post(`/api/reports/${report.id}/revise`).set(auth()).send({
      expectedVersion: 1,
      reason: '롤백 검증',
      content: '남으면 안 되는 내용',
    }).expect(500);
    auditSpy.mockRestore();

    const after = (await http.get(`/api/reports/${report.id}`).set(auth()).expect(200)).body;
    expect(after).toMatchObject({ content: '롤백 원문', version: 1, approvalStatus: 'approved' });
    expect((await http.get(`/api/reports/${report.id}/revisions`).set(auth()).expect(200)).body).toEqual([]);
  });

  it('rejected resubmit and approved reject explicitly clear stale decision metadata', async () => {
    const session = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10,
      sessionDate: '2096-08-06',
      startTime: '05:00',
      durationMinutes: 60,
      studentIds: [1],
      force: true,
    }).expect(201)).body.row;
    const report = (await http.post('/api/reports').set(auth()).send({
      sessionId: session.id,
      studentId: 1,
      content: '전이 메타 검증',
      status: 'submitted',
    }).expect(201)).body;

    const rejected = (await http.post(`/api/reports/${report.id}/reject`).set(auth())
      .send({ reason: '보완 필요' }).expect(201)).body;
    expect(rejected).toMatchObject({ approvalStatus: 'rejected', rejectedReason: '보완 필요' });
    expect(rejected.approvedAt ?? null).toBeNull();
    expect(rejected.approvedBy ?? null).toBeNull();

    const resubmitted = (await http.post(`/api/reports/${report.id}/submit`).set(auth()).send({}).expect(201)).body;
    expect(resubmitted.approvalStatus).toBe('submitted');
    expect(resubmitted.rejectedReason ?? null).toBeNull();
    expect(resubmitted.approvedAt ?? null).toBeNull();
    expect(resubmitted.approvedBy ?? null).toBeNull();

    const approved = (await http.post(`/api/reports/${report.id}/approve`).set(auth()).send({}).expect(201)).body;
    expect(approved.approvalStatus).toBe('approved');
    expect(approved.rejectedReason ?? null).toBeNull();

    const rejectedAgain = (await http.post(`/api/reports/${report.id}/reject`).set(auth())
      .send({ reason: '승인 후 재검토' }).expect(201)).body;
    expect(rejectedAgain.approvalStatus).toBe('rejected');
    expect(rejectedAgain.approvedAt ?? null).toBeNull();
    expect(rejectedAgain.approvedBy ?? null).toBeNull();
  });
});
