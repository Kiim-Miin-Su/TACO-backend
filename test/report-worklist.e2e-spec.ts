import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  addDaysISO,
  createTestApp,
  E2E_APP_BOOT_TIMEOUT_MS,
  mondayISO,
} from './setup-app';

jest.setTimeout(30_000);
jest.retryTimes(0);

describe('[TBO-86G2] 보고서 filter + 역할별 worklist (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });
  const historicalDate = addDaysISO(mondayISO(), -400);
  let sessionId: number;
  let reportId: number;
  let subjectId: number;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['manager', 'park_inst', 'jung_inst']) {
      tokens[webId] = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
    const created = (await http.post('/api/schedule/historical-completed').set(auth('manager')).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [1],
      sessionDate: historicalDate,
      startTime: '13:10',
      durationMinutes: 60,
      kind: 'class',
      mode: 'online',
      topic: 'TBO-86G2 worklist',
      importReason: '리포트 worklist 전이 검증',
    }).expect(201)).body;
    sessionId = created.row.id;
  }, E2E_APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('90일보다 오래된 missing도 기본 worklist에 포함하고 역할 scope를 강제한다', async () => {
    const manager = (await http.get('/api/reports/worklist').set(auth('manager')).expect(200)).body;
    expect(manager.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `report:${sessionId}:1`,
        type: 'report_missing',
        sessionId,
        instructorId: 1,
        studentId: 1,
      }),
    ]));

    const mine = (await http.get('/api/reports/worklist').set(auth('park_inst')).query({
      from: historicalDate,
      to: historicalDate,
    }).expect(200)).body;
    expect(mine).toMatchObject({ instructorId: 1, itemCount: 1, sessionCount: 1 });
    expect(mine.items[0]).toMatchObject({ sessionId, studentId: 1, type: 'report_missing' });

    const other = (await http.get('/api/reports/worklist').set(auth('jung_inst')).query({
      from: historicalDate,
      to: historicalDate,
    }).expect(200)).body;
    expect(other.itemCount).toBe(0);
    await http.get('/api/reports/worklist').set(auth('park_inst')).query({ instructorId: 2 }).expect(403);
  });

  it('missing → draft → submitted 제거 → rejected 재등장을 같은 서버 정책으로 전이한다', async () => {
    const created = (await http.post('/api/reports').set(auth('park_inst')).send({
      sessionId,
      studentId: 1,
      content: 'worklist 상태 전이',
      progressPage: '12p',
      homework: '복습',
      status: 'draft',
    }).expect(201)).body;
    reportId = created.id;

    const draft = (await http.get('/api/reports/worklist').set(auth('park_inst')).query({
      from: historicalDate,
      to: historicalDate,
    }).expect(200)).body;
    expect(draft.items).toEqual([
      expect.objectContaining({ reportId, type: 'report_draft', sessionId, studentId: 1 }),
    ]);

    await http.post(`/api/reports/${reportId}/submit`).set(auth('park_inst')).expect(201);
    expect((await http.get('/api/reports/worklist').set(auth('park_inst')).query({
      from: historicalDate,
      to: historicalDate,
    }).expect(200)).body.itemCount).toBe(0);

    await http.post(`/api/reports/${reportId}/reject`).set(auth('manager'))
      .send({ reason: '내용 보완이 필요합니다.' }).expect(201);
    const rejected = (await http.get('/api/reports/worklist').set(auth('park_inst')).query({
      from: historicalDate,
      to: historicalDate,
    }).expect(200)).body;
    expect(rejected.items).toEqual([
      expect.objectContaining({ reportId, type: 'report_rejected', rejectedReason: '내용 보완이 필요합니다.' }),
    ]);
  });

  it('목록 filter는 날짜·학생·과목·강사·상태를 조합하고 강사 IDOR를 차단한다', async () => {
    const detail = (await http.get(`/api/reports/${reportId}`).set(auth('manager')).expect(200)).body;
    subjectId = detail.context.subject.id;
    const rows = (await http.get('/api/reports').set(auth('manager')).query({
      from: historicalDate,
      to: historicalDate,
      studentId: 1,
      subjectId,
      instructorId: 1,
      status: 'submitted',
      approvalStatus: 'rejected',
    }).expect(200)).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: reportId, sessionId, subjectId });

    expect((await http.get('/api/reports').set(auth('manager')).query({
      from: historicalDate,
      to: historicalDate,
      subjectId: subjectId + 999,
    }).expect(200)).body).toEqual([]);
    await http.get('/api/reports').set(auth('park_inst')).query({ instructorId: 2 }).expect(403);
  });

  it('비정규 ID·날짜·역전 기간·알 수 없는 query를 쓰기 전에 400으로 거부한다', async () => {
    await http.get('/api/reports').set(auth('manager')).query({ studentId: '01' }).expect(400);
    await http.get('/api/reports/worklist').set(auth('manager')).query({ subjectId: '1.0' }).expect(400);
    await http.get('/api/reports').set(auth('manager')).query({ from: '2026-99-01' }).expect(400);
    await http.get('/api/reports/worklist').set(auth('manager')).query({
      from: '2026-08-02',
      to: '2026-08-01',
    }).expect(400);
    await http.get('/api/reports').set(auth('manager')).query({ evil: '1' }).expect(400);
  });
});
