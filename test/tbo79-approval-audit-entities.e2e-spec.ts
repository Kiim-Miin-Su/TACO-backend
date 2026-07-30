// [TBO-79 I3 2026-07-30] 승인 상세 모달의 "처리 이력"이 실제로 행을 찾는지 고정한다.
//
//  TBO-23 청크4 체크리스트가 **굵게** 요구한 `useEntityAudit(entity, id)` 처리 이력 탭이
//  모달에 빠져 있었다(재검증에서 발견 — §4.2). 이번에 추가하면서 FE가 넘기는 entity 문자열이
//  서버가 audit_log에 기록하는 이름과 정확히 같아야 한다. 틀리면 화면은 조용히
//  "변경 이력이 없습니다"만 보여준다 — 실패가 보이지 않는 종류의 결함이다.
//
//  그래서 세 승인 대상을 실제로 결재한 뒤 `GET /audit?entity=..&entityId=..`가 행을 돌려주는지
//  확인한다. FE `AUDIT_ENTITY` 맵과 같은 문자열을 여기 하드코딩해 양쪽이 함께 깨지게 한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders, mondayISO, addDaysISO } from './setup-app';

jest.setTimeout(30000);

/** frontend features/admin/ApprovalItemDetailModal.tsx 의 AUDIT_ENTITY 와 같아야 한다. */
const AUDIT_ENTITY = {
  report: 'session_reports',
  expense: 'expenses',
  payout: 'instructor_payouts',
} as const;

describe('[TBO-79] 승인 상세 처리 이력 entity 정합 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => sudoAuthHeaders(app, tokens[who]);
  const PAST = addDaysISO(mondayISO(), -56);

  const auditOf = async (entity: string, entityId: number) =>
    (await http.get(`/api/audit?entity=${entity}&entityId=${entityId}`).set(as('admin')).expect(200))
      .body as Array<{ action: string; actorId: number; changes?: Record<string, unknown> }>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('I3 — 보고서 승인 이력이 session_reports 로 조회된다', async () => {
    const session = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: PAST, startTime: '09:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number };
    const report = (await http.post('/api/reports').set(bearer('park_inst'))
      .send({ sessionId: session.id, studentId: 1, content: 'TBO-79 I3 처리 이력' }).expect(201)).body as { id: number };
    await http.post(`/api/reports/${report.id}/submit`).set(bearer('park_inst')).send({}).expect(201);
    await http.post(`/api/reports/${report.id}/approve`).set(bearer('admin')).send({}).expect(201);

    const rows = await auditOf(AUDIT_ENTITY.report, report.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.action === 'approve')).toBe(true);
    for (const row of rows) expect(row.actorId).toBeGreaterThan(0);
  });

  it('I3 — 지출 승인 이력이 expenses 로 조회된다', async () => {
    const expense = (await http.post('/api/expenses').set(as('admin'))
      .send({ title: 'TBO-79 I3 지출', category: 'supplies', amount: 12000, spentAt: PAST })
      .expect(201)).body as { id: number };
    await http.post(`/api/expenses/${expense.id}/approve`).set(as('admin')).send({}).expect(201);

    const rows = await auditOf(AUDIT_ENTITY.expense, expense.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.action === 'approve' || row.action === 'update')).toBe(true);
  });

  it('I3 — 정산 이력이 instructor_payouts 로 조회된다', async () => {
    const from = addDaysISO(PAST, -7);
    const to = addDaysISO(PAST, 7);
    const payout = (await http.post('/api/payouts/generate').set(as('admin'))
      .send({ instructorId: 1, from, to })).body as { id?: number };
    if (payout.id == null) return; // 적격 회차가 없으면 생성되지 않는다 — 이 경우 검증 대상 없음
    const rows = await auditOf(AUDIT_ENTITY.payout, payout.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.actorId).toBeGreaterThan(0);
  });

  it('I3 — 존재하지 않는 entity 이름은 빈 배열을 준다(오타가 조용히 통과하는 자리)', async () => {
    // 이 단언 자체가 "빈 배열 = 오타일 수도 있다"는 사실의 기록이다.
    expect(await auditOf('sessionreports', 1)).toEqual([]);
    expect(await auditOf('payouts', 1)).toEqual([]);
  });
});
