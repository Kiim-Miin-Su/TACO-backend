import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { assertExpectedAfter } from '../src/common/expected-after.util';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { SESSIONS, type ClassSession } from '../src/modules/schedule/schedule.entity';
import { createTestApp } from './setup-app';

const FROM = '2026-06-01';
const TO = '2026-06-30';

describe('session joined-table expected/after integrity (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let token = '';
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => app.close());

  const preview = async (instructorId = 1) =>
    (await http.get(`/api/payouts/preview?instructorId=${instructorId}&from=${FROM}&to=${TO}`).set(auth()).expect(200)).body;
  const summary = async (instructorId = 1) =>
    (await http.get(`/api/schedule/instructor-attendance-summary?instructorId=${instructorId}&from=${FROM}&to=${TO}`).set(auth()).expect(200)).body.rows[0];
  const relations = async (sessionId: number) => ({
    attendance: (await http.get(`/api/attendance?sessionId=${sessionId}`).set(auth()).expect(200)).body
      .map((row: { id: number; studentId: number; status: string }) => ({ id: row.id, studentId: row.studentId, status: row.status })),
    reports: (await http.get(`/api/reports?sessionId=${sessionId}`).set(auth()).expect(200)).body
      .map((row: { id: number; studentId: number; approvalStatus: string }) => ({ id: row.id, studentId: row.studentId, approvalStatus: row.approvalStatus })),
  });

  it('강사 출결 변경은 확인 전 차단하고, 확인 후 시수·정산액만 expected만큼 변경한다', async () => {
    const beforePreview = await preview();
    const line = beforePreview.lines[0];
    const beforeSummary = await summary();
    const beforeRelations = await relations(line.sessionId);

    const blocked = await http.patch(`/api/schedule/${line.sessionId}`).set(auth())
      .send({ instructorAttendance: 'absent' }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(blocked.body.impact.delta).toMatchObject({
      teachingMinutes: -line.durationMinutes,
      payoutEligibleMinutes: -line.durationMinutes,
      computedAmount: -line.amount,
    });
    assertExpectedAfter('ack 전 관계 무변경', beforeRelations, await relations(line.sessionId));

    await http.patch(`/api/schedule/${line.sessionId}`).set(auth())
      .send({ instructorAttendance: 'absent', acknowledgeAccountingImpact: true }).expect(200);
    const afterPreview = await preview();
    const afterSummary = await summary();
    assertExpectedAfter('강사 결석 후 파생값', {
      preview: {
        sessionCount: beforePreview.sessionCount - 1,
        totalMinutes: beforePreview.totalMinutes - line.durationMinutes,
        computedAmount: beforePreview.computedAmount - line.amount,
      },
      summary: { teachingMinutes: beforeSummary.teachingMinutes - line.durationMinutes, absent: beforeSummary.absent + 1 },
      relations: beforeRelations,
    }, {
      preview: { sessionCount: afterPreview.sessionCount, totalMinutes: afterPreview.totalMinutes, computedAmount: afterPreview.computedAmount },
      summary: { teachingMinutes: afterSummary.teachingMinutes, absent: afterSummary.absent },
      relations: await relations(line.sessionId),
    });

    await http.patch(`/api/schedule/${line.sessionId}`).set(auth())
      .send({ clearInstructorAttendance: true, acknowledgeAccountingImpact: true }).expect(200);
    const restored = await preview();
    assertExpectedAfter('강사 출결 clear 복원', {
      sessionCount: beforePreview.sessionCount,
      totalMinutes: beforePreview.totalMinutes,
      computedAmount: beforePreview.computedAmount,
    }, { sessionCount: restored.sessionCount, totalMinutes: restored.totalMinutes, computedAmount: restored.computedAmount });
  });

  it('학생 출결 변경은 강사 시수·정산액을 바꾸지 않는다', async () => {
    const line = (await preview()).lines[0];
    await http.put('/api/attendance').set(auth()).send({ sessionId: line.sessionId, studentId: 1, status: 'present' }).expect(200);
    const before = { preview: await preview(), summary: await summary() };
    const updated = (await http.put('/api/attendance').set(auth())
      .send({ sessionId: line.sessionId, studentId: 1, status: 'absent' }).expect(200)).body;
    const after = { preview: await preview(), summary: await summary() };
    assertExpectedAfter('학생 출결은 강사 회계 파생값 불변', {
      preview: { totalMinutes: before.preview.totalMinutes, computedAmount: before.preview.computedAmount },
      summary: { teachingMinutes: before.summary.teachingMinutes },
      attendance: { id: updated.id, status: 'absent' },
    }, {
      preview: { totalMinutes: after.preview.totalMinutes, computedAmount: after.preview.computedAmount },
      summary: { teachingMinutes: after.summary.teachingMinutes },
      attendance: { id: updated.id, status: updated.status },
    });
  });

  it('정산 연결 세션은 확인값이 있어도 원장 회수 전 변경·삭제되지 않는다', async () => {
    const payouts = (await http.get('/api/payouts').set(auth()).expect(200)).body;
    const paid = payouts.find((row: { instructorId: number; status: string }) => row.instructorId === 2 && row.status === 'paid');
    const sessionId = paid.lines[0].sessionId;
    const before = (await http.get(`/api/schedule?from=${FROM}&to=${TO}&instructorId=2`).set(auth()).expect(200)).body
      .find((row: { id: number }) => row.id === sessionId);
    const blocked = await http.patch(`/api/schedule/${sessionId}`).set(auth())
      .send({ durationMinutes: before.durationMinutes + 30, acknowledgeAccountingImpact: true }).expect(409);
    expect(blocked.body.code).toBe('PAYOUT_REVERSAL_REQUIRED');
    await http.delete(`/api/schedule/${sessionId}`).set(auth()).expect(409);
    const after = (await http.get(`/api/schedule?from=${FROM}&to=${TO}&instructorId=2`).set(auth()).expect(200)).body
      .find((row: { id: number }) => row.id === sessionId);
    assertExpectedAfter('정산 연결 세션 불변', before, after);
  });

  it('반복 범위 변경은 동반 회차 하나라도 정산 연결이면 시리즈 전체를 불변으로 둔다', async () => {
    // [TBO-29C C2] 시리즈는 서버 발급 bulk command로 생성(클라이언트 seriesId 폐기). 2099-12-01=화.
    const madeSeries = (await http.post('/api/schedule/series').set(auth()).send({
      courseId: 10, instructorId: 1,
      repeat: { kind: 'weekly', weekdays: [2], startsOn: '2099-12-01', endsOn: '2099-12-08' },
      startTime: '08:00', durationMinutes: 60, topic: '정산 잠금 반복', force: true,
    }).expect(201)).body as { series: { id: number }; rows: Array<{ id: number }> };
    const seriesId = madeSeries.series.id;
    const [first, second] = madeSeries.rows;

    const db = app.get(InMemoryDatabase);
    db.update<ClassSession>(SESSIONS, second.id, { payoutId: 999 });
    const before = db.findBy<ClassSession>(SESSIONS, (row) => row.seriesId === seriesId)
      .map(({ id, sessionDate, durationMinutes, topic, payoutId }) => ({ id, sessionDate, durationMinutes, topic, payoutId }));

    const blocked = await http.patch(`/api/schedule/${first.id}`).set(auth()).send({
      durationMinutes: 90,
      topic: '변경되면 안 됨',
      scope: 'this_and_following',
      acknowledgeAccountingImpact: true,
      force: true,
    }).expect(409);
    expect(blocked.body.code).toBe('PAYOUT_REVERSAL_REQUIRED');
    expect(blocked.body.impact.payoutId).toBe(999);

    const after = db.findBy<ClassSession>(SESSIONS, (row) => row.seriesId === seriesId)
      .map(({ id, sessionDate, durationMinutes, topic, payoutId }) => ({ id, sessionDate, durationMinutes, topic, payoutId }));
    assertExpectedAfter('반복 시리즈 정산 잠금 불변', before, after);
  });
});
