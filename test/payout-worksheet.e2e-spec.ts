// [TBO-64 2026-07-24] 시수 워크시트 e2e — 대표 지시 10항목 검증.
//  분류(auto/manual/excluded)·기본값(시급×시간)·지각·리포트 미작성 = 빈칸→책정→합계 포함·
//  generate 정합(같은 분류 소비)·연결 후 가격 불변·권한.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders , patchSessionAckingImpact } from './setup-app';

describe('[TBO-64] 시수 워크시트 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const sudo = (who: string) => sudoAuthHeaders(app, tokens[who]);
  // 주간 픽스처와 격리된 미래 기간(2098년) — 다른 스위트 상태와 독립.
  const FROM = '2098-03-02';
  const TO = '2098-03-08';

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  const makeSession = async (over: Record<string, unknown> = {}) =>
    (await http.post('/api/schedule').set(auth('admin')).send({
      courseId: 10, instructorId: 1, studentIds: [1], sessionDate: FROM,
      startTime: '08:00', durationMinutes: 120, force: true, ...over,
    }).expect(201)).body.row;
  const held = (id: number) => http.patch(`/api/schedule/${id}`).set(auth('admin')).send({ status: 'held', force: true }).expect(200);
  const approveReport = async (sessionId: number, studentId = 1) => {
    const r = (await http.post('/api/reports').set(auth('admin'))
      .send({ sessionId, studentId, content: '워크시트 검증 본문' }).expect(201)).body;
    await http.post(`/api/reports/${r.id}/approve`).set(auth('admin')).expect(201);
    return r.id as number;
  };
  const worksheet = async () =>
    (await http.get('/api/payouts/worksheet').query({ instructorId: 1, from: FROM, to: TO })
      .set(auth('admin')).expect(200)).body;
  const rowOf = (ws: { rows: Array<{ sessionId: number }> }, id: number) =>
    (ws.rows as Array<Record<string, never>>).find((row: { sessionId?: number }) => row.sessionId === id)!;

  let AUTO = 0;    // 정상: held+출석+리포트 승인 → auto 기본값(코스10 시급 50,000 × 2h = 100,000)
  let LATE = 0;    // 지각: held+late+리포트 승인 → manual(빈칸)
  let NOREP = 0;   // 리포트 미작성: held+출석 → manual(빈칸)
  let ABSENT = 0;  // 결석 → excluded
  let SCHED = 0;   // 미진행(scheduled) → excluded
  let AUTO_REPORT = 0;

  it('회차 준비 — 분류 5종 시나리오 구성(출결 수정 API 재사용)', async () => {
    AUTO = (await makeSession({ startTime: '08:00' })).id;
    LATE = (await makeSession({ sessionDate: '2098-03-03', startTime: '10:30' })).id;
    NOREP = (await makeSession({ startTime: '13:00' })).id;
    ABSENT = (await makeSession({ startTime: '15:30' })).id;
    SCHED = (await makeSession({ startTime: '18:00' })).id;
    for (const id of [AUTO, LATE, NOREP, ABSENT]) await held(id);
    // 강사 출결 수정(워크시트 요건 ③·⑥ — 기존 PATCH 재사용, 매니저)
    expect((await patchSessionAckingImpact(http, auth('manager'), LATE, { instructorAttendance: 'late', force: true })).status).toBe(200); // [74D-0]
    // held 회차의 출결 변경은 회계 영향 확인(ack) 규약 — FE 모달 확인과 동일 플래그 동반.
    expect((await patchSessionAckingImpact(http, auth('manager'), ABSENT, { instructorAttendance: 'absent', force: true })).status).toBe(200); // [74D-0]
    AUTO_REPORT = await approveReport(AUTO);
    await approveReport(LATE);
    // 학생 출결도 워크시트 화면에서 수정 가능(기존 PUT 재사용) — 참가자 출결 표시 검증용
    await http.put('/api/attendance').set(auth('manager')).send({ sessionId: AUTO, studentId: 1, status: 'present' }).expect(200);
  });

  it('분류·기본값 — auto=시급×시간, 지각·리포트 미작성=빈칸(manual), 결석·미진행=excluded', async () => {
    const ws = await worksheet();
    const auto = rowOf(ws, AUTO) as Record<string, never> & { pricing: Record<string, unknown>; participants: Array<Record<string, unknown>> };
    expect(auto.pricing).toMatchObject({ kind: 'auto', autoAmount: 100000, effectiveAmount: 100000 }); // 대표 예시 ⑦: 시급×2h
    expect(auto).toMatchObject({ subjectId: 1, subjectName: '영어' });
    expect(auto.participants[0]).toMatchObject({
      studentId: 1,
      attendance: 'present',
      reportId: AUTO_REPORT,
      reportApproval: 'approved',
    });

    const late = rowOf(ws, LATE) as { pricing: Record<string, unknown> };
    expect(late.pricing).toMatchObject({ kind: 'manual', effectiveAmount: null }); // 빈칸(대표 지시 ⑧)
    expect((late.pricing as { manualReasons: string[] }).manualReasons).toContain('late');

    const norep = rowOf(ws, NOREP) as { pricing: { manualReasons: string[]; effectiveAmount: null }; participants: Array<{ reportApproval: string | null }> };
    expect(norep.pricing.manualReasons).toContain('report_incomplete');
    expect(norep.participants[0]).toMatchObject({ reportId: null, reportApproval: null }); // 미작성 표시

    expect((rowOf(ws, ABSENT) as { pricing: { excludedReason: string } }).pricing.excludedReason).toBe('instructor_absent');
    expect((rowOf(ws, SCHED) as { pricing: { excludedReason: string } }).pricing.excludedReason).toBe('not_held');

    // 합계(⑨): 책정 전 = auto 1건만 포함, 미책정 2건 표기
    expect(ws.totals).toMatchObject({ includedCount: 1, totalAmount: 100000, unpricedCount: 2, totalMinutes: 120 });
  });

  it('가격 책정(⑧) — 지각·리포트 미작성에 금액 확정 → 합계 반영, 해제(null) → 빈칸 복귀', async () => {
    await http.put(`/api/schedule/${LATE}/pay-amount`).set(auth('admin')).send({ amount: 70000 }).expect(403)
      .then((response) => expect(response.body.code).toBe('SUDO_REQUIRED'));
    await http.put(`/api/schedule/${LATE}/pay-amount`).set(sudo('manager')).send({ amount: 70000 }).expect(403);
    await http.put(`/api/schedule/${LATE}/pay-amount`).set(sudo('admin')).send({ amount: 70000 }).expect(200);
    await http.put(`/api/schedule/${NOREP}/pay-amount`).set(sudo('admin')).send({ amount: 50000 }).expect(200);
    let ws = await worksheet();
    expect((rowOf(ws, LATE) as { pricing: { effectiveAmount: number } }).pricing.effectiveAmount).toBe(70000);
    expect(ws.totals).toMatchObject({ includedCount: 3, totalAmount: 220000, unpricedCount: 0, manualAmount: 120000, autoAmount: 100000 });
    // 해제 → 빈칸 복귀(합계 제외)
    await http.put(`/api/schedule/${NOREP}/pay-amount`).set(sudo('admin')).send({ amount: null }).expect(200);
    ws = await worksheet();
    expect(ws.totals).toMatchObject({ includedCount: 2, totalAmount: 170000, unpricedCount: 1 });
    // 가드: 결석·미진행 회차는 책정 불가, 음수 400, 강사 403
    await http.put(`/api/schedule/${ABSENT}/pay-amount`).set(sudo('admin')).send({ amount: 10000 }).expect(400);
    await http.put(`/api/schedule/${SCHED}/pay-amount`).set(sudo('admin')).send({ amount: 10000 }).expect(400);
    await http.put(`/api/schedule/${LATE}/pay-amount`).set(sudo('admin')).send({ amount: -1 }).expect(400);
    await http.put(`/api/schedule/${LATE}/pay-amount`).set(auth('park_inst')).send({ amount: 1 }).expect(403);
    await http.get('/api/payouts/worksheet').query({ instructorId: 1, from: FROM, to: TO }).set(auth('park_inst')).expect(403);
  });

  it('generate 정합(단일 진실원) — 확정 라인(auto+책정)만 정산, 미책정 잔존 → 연결 후 가격 불변', async () => {
    const payout = (await http.post('/api/payouts/generate').set(auth('admin'))
      .send({ instructorId: 1, from: FROM, to: TO }).expect(201)).body;
    // auto(100,000) + 책정된 지각(70,000) = 170,000 · 미책정(NOREP)은 제외돼 잔존
    expect(payout.sessionCount).toBe(2);
    expect(payout.amount).toBe(170000);
    const lineIds = payout.lines.map((l: { sessionId: number }) => l.sessionId).sort((a: number, b: number) => a - b);
    expect(lineIds).toEqual([AUTO, LATE].sort((a, b) => a - b));
    // 연결된 회차는 가격 변경 409(확정 스냅샷 불변), 잔존 회차는 이후 책정 → 다음 산정 대상
    await http.put(`/api/schedule/${LATE}/pay-amount`).set(sudo('admin')).send({ amount: 90000 }).expect(409);
    const ws = await worksheet();
    expect((rowOf(ws, LATE) as { pricing: { excludedReason: string } }).pricing.excludedReason).toBe('payout_linked');
    expect((rowOf(ws, NOREP) as { pricing: { kind: string } }).pricing.kind).toBe('manual'); // 잔존 — uncovered 대상 유지

    // 반려는 정산 연결만 해제한다. 사용자가 입력한 회차 override(70,000)는 소실되면 안 된다.
    await http.post(`/api/payouts/${payout.id}/reject`).set(auth('admin'))
      .send({ reason: '책정값 보존 회귀 검증' }).expect(201);
    const released = await worksheet();
    expect((rowOf(released, LATE) as { pricing: { overrideAmount: number; effectiveAmount: number } }).pricing)
      .toMatchObject({ overrideAmount: 70000, effectiveAmount: 70000 });
  });
});
