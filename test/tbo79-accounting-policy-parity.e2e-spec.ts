// [TBO-79 B1~B3 2026-07-30] 회계 영향 미리보기 ↔ 정산서 라인 산정의 **단일 계산 정책** 회귀.
//
//  결함(감사에서 확인): session-accounting.policy는 `held ∧ 강사 출결 ≠ absent`만 보고
//  payout-worksheet.policy는 지각·학생 출결 미기록·리포트 미승인을 manual(합계 제외)로,
//  책정가(instructorPayAmount)를 자동 산정보다 우선으로 처리했다. 두 정책이 갈라져서
//   ① present→late 전이가 delta 0으로 계산돼 **ack 없이 200**인데 정산 preview에서는 라인이 통째로 빠지고
//   ② 책정가가 있는 세션의 409 미리보기가 시급×시간을 보고해 ack한 expected와 정산 after가 달랐다.
//
//  이 스위트는 두 실패를 각각 못박는다. 수정 전 구현에서는 ①이 200으로, ②가 자동 산정액으로 통과한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  createTestApp,
  E2E_APP_BOOT_TIMEOUT_MS,
  mondayISO,
  addDaysISO,
  sudoAuthHeaders,
} from './setup-app';

jest.setTimeout(20000);

describe('[TBO-79] 회계 미리보기 ↔ 정산 산정 단일 정책 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => sudoAuthHeaders(app, tokens[who]);
  const PAST = addDaysISO(mondayISO(), -28);
  const FROM = addDaysISO(PAST, -7);
  const TO = addDaysISO(PAST, 7);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  }, E2E_APP_BOOT_TIMEOUT_MS);
  afterAll(async () => { await app.close(); });

  /** 정산 대상으로 완전히 익은 회차: held + 학생 출결 기록 + 리포트 승인. */
  const makeSettledSession = async (startTime: string, dayOffset = 0, durationMinutes = 60) => {
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: addDaysISO(PAST, dayOffset), startTime, durationMinutes, force: true })
      .expect(201)).body.row;
    await http.put('/api/attendance').set(as('admin')).send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);
    await http.patch(`/api/schedule/${created.id}`).set(as('admin')).send({ instructorAttendance: 'present', force: true }).expect(200);
    const report = (await http.post('/api/reports').set(as('park_inst'))
      .send({ sessionId: created.id, studentId: 1, content: 'TBO-79 정책 정합 회귀' }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/submit`).set(as('park_inst')).send({}).expect(201);
    await http.post(`/api/reports/${report.id}/approve`).set(as('admin')).send({}).expect(201);
    expect((await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body.status).toBe('held');
    return { id: created.id as number, reportId: report.id as number };
  };

  const previewOf = async () => (await http
    .get(`/api/payouts/preview?instructorId=1&from=${FROM}&to=${TO}`)
    .set(as('admin')).expect(200)).body as { computedAmount: number; sessionCount: number; lines?: Array<{ sessionId: number; amount: number }> };

  const worksheetRow = async (sessionId: number) => {
    const sheet = (await http.get(`/api/payouts/worksheet?instructorId=1&from=${FROM}&to=${TO}`)
      .set(as('admin')).expect(200)).body as { rows: Array<{ sessionId: number; pricing: { kind: string; manualReasons: string[]; effectiveAmount: number | null } }> };
    return sheet.rows.find((row) => Number(row.sessionId) === Number(sessionId));
  };

  it('① present → late 는 정산 예상액을 바꾸므로 ack 없이 통과하면 안 된다', async () => {
    const { id } = await makeSettledSession('08:00', 0);
    const before = await previewOf();
    const line = before.lines?.find((row) => Number(row.sessionId) === id);
    expect(line).toBeDefined();
    expect(line!.amount).toBeGreaterThan(0);

    // 정책 분기 시절엔 delta 0 → changed:false → 200이었다.
    const blocked = await http.patch(`/api/schedule/${id}`).set(as('admin'))
      .send({ instructorAttendance: 'late', force: true }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(blocked.body.impactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(blocked.body.impact.delta.computedAmount).toBe(-line!.amount);
    // 시수(가르친 시간)는 지각이어도 유지 — 달라지는 건 정산 적격뿐.
    expect(blocked.body.impact.delta.teachingMinutes).toBe(0);
    expect(blocked.body.impact.delta.payoutEligibleMinutes).toBe(-60);

    // 거부된 요청은 아무것도 바꾸지 않는다(before === after).
    expect((await http.get(`/api/schedule/${id}`).set(as('manager')).expect(200)).body.instructorAttendance).toBe('present');
    expect((await previewOf()).computedAmount).toBe(before.computedAmount);

    // ack + hash 결속 → 200. 이후 실제 정산이 미리보기와 일치한다.
    await http.patch(`/api/schedule/${id}`).set(as('admin')).send({
      instructorAttendance: 'late',
      force: true,
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(200);

    const after = await previewOf();
    expect(after.computedAmount).toBe(before.computedAmount - line!.amount);
    const row = await worksheetRow(id);
    expect(row?.pricing.kind).toBe('manual');
    expect(row?.pricing.manualReasons).toContain('late');
  });

  it('② 책정가가 있는 회차의 미리보기 before 는 실제 정산 라인 금액과 같아야 한다', async () => {
    const { id } = await makeSettledSession('10:00', 1);
    const OVERRIDE = 123000;
    await http.put(`/api/schedule/${id}/pay-amount`).set(as('admin')).send({ amount: OVERRIDE }).expect(200);

    const row = await worksheetRow(id);
    expect(row?.pricing.effectiveAmount).toBe(OVERRIDE);
    const line = (await previewOf()).lines?.find((entry) => Number(entry.sessionId) === id);
    expect(line?.amount).toBe(OVERRIDE);

    // 정책 분기 시절엔 시급×시간(자동 산정액)을 보고했다.
    const blocked = await http.patch(`/api/schedule/${id}`).set(as('manager'))
      .send({ durationMinutes: 90 }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(blocked.body.impact.before.computedAmount).toBe(OVERRIDE);
  });

  it('③ 학생 출결 미기록 회차는 미리보기에서도 자동 정산 대상이 아니다', async () => {
    // 학생 출결 없이 강사 출결만으로 held 를 만들 수는 없으므로, 출결 초기화로 미기록을 만든다.
    const { id } = await makeSettledSession('13:00', 2);
    const before = await previewOf();
    const line = before.lines?.find((row) => Number(row.sessionId) === id);
    expect(line?.amount).toBeGreaterThan(0);

    // 출결 초기화 = held → scheduled. 정산 예상액이 빠지므로 ack 게이트가 걸려야 한다(B4).
    const cleared = await http.delete(`/api/attendance/${id}/1`).set(as('admin')).send({ reason: 'TBO-79 미기록 회귀' });
    expect([200, 409]).toContain(cleared.status);
    if (cleared.status === 409) {
      expect(cleared.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
      expect((await previewOf()).computedAmount).toBe(before.computedAmount);
      await http.delete(`/api/attendance/${id}/1`).set(as('admin')).send({
        reason: 'TBO-79 미기록 회귀',
        acknowledgeAccountingImpact: true,
        expectedAccountingImpactHash: cleared.body.impactHash,
      }).expect(200);
    }
    expect((await previewOf()).computedAmount).toBe(before.computedAmount - line!.amount);
  });
});
