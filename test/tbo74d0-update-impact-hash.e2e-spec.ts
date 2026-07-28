// [74D-0 2026-07-28] session_update 영향 hash·stale 방어 — 삭제(992307e)와 동일 계약을 update에.
//  계약: 회계 영향 변경(held·정산 잠금 대상)은 첫 409에 impact+impactHash, 재요청은 ack+hash 일치
//  필수(불일치=새 409·mutation 0). 반복 update 요청은 생성 snapshot(impactSessionIds)과 승인 잠금 후
//  대상이 다르면 REQUEST_SCOPE_STALE 전체 rollback. force(충돌)는 회계 확인을 우회하지 못한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mondayISO, addDaysISO, sudoAuthHeaders } from './setup-app';

jest.setTimeout(20000);

describe('[74D-0] session_update 영향 hash·stale 방어 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => sudoAuthHeaders(app, tokens[who]);
  const PAST = addDaysISO(mondayISO(), -21); // 확실한 과거(3주 전 — 픽스처와 무관, 단언은 회차 단위)

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  const makeHeldSession = async (startTime: string, dayOffset = 0, durationMinutes = 60) => {
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: addDaysISO(PAST, dayOffset), startTime, durationMinutes, force: true })
      .expect(201)).body.row;
    // 학생 출결 기록 → 자동 held(사실 기록 전이 — TBO-66 C1)
    await http.put('/api/attendance').set(as('manager')).send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);
    expect((await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body.status).toBe('held');
    return created.id as number;
  };

  it('① held 시수 변경: 첫 409=impact+impactHash → ack만(무hash) 409 → hash 결속 재요청 200 + 감사 지문', async () => {
    const id = await makeHeldSession('08:00', 0);
    // 60→90분: held 세션 시수 변경 = 회계 영향
    const first = await http.patch(`/api/schedule/${id}`).set(as('manager')).send({ durationMinutes: 90 }).expect(409);
    expect(first.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(first.body.impactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.body.impact.delta.teachingMinutes).toBe(30);
    // [74D-0] ack만으로는 불가(맹목 확인 차단) — hash 미회신 = 409, mutation 0
    await http.patch(`/api/schedule/${id}`).set(as('manager'))
      .send({ durationMinutes: 90, acknowledgeAccountingImpact: true }).expect(409);
    expect((await http.get(`/api/schedule/${id}`).set(as('manager'))).body.durationMinutes).toBe(60); // 무변 확인
    // hash 결속 재요청 = 200 + 응답에 적용 영향·지문
    const ok = await http.patch(`/api/schedule/${id}`).set(as('manager'))
      .send({ durationMinutes: 90, acknowledgeAccountingImpact: true, expectedAccountingImpactHash: first.body.impactHash })
      .expect(200);
    expect(ok.body.accountingImpactHash).toBe(first.body.impactHash);
    expect(ok.body.row.durationMinutes).toBe(90);
    // 감사에 확인 지문 영속 — "무엇을 보고 승인했는가"
    const audit = (await http.get(`/api/audit?entity=class_sessions&entityId=${id}`).set(as('admin')).expect(200)).body as Array<{
      action: string; changes?: Record<string, { after?: { hash?: string } }>;
    }>;
    expect(audit.some((row) => row.action === 'update' && row.changes?.accountingImpactAcknowledgement?.after?.hash === first.body.impactHash)).toBe(true);
  });

  it('② stale 확인 차단: 확인 후 영향이 달라지면(대상 변형) 옛 hash 409 + 최신 impact/hash → 새 hash로만 200', async () => {
    const id = await makeHeldSession('09:00', 1); // 다른 날 — ①의 연장 회차와 충돌 배제
    const first = await http.patch(`/api/schedule/${id}`).set(as('manager')).send({ durationMinutes: 90 }).expect(409);
    // 사용자가 미리보기를 보는 사이 다른 관리자가 시수를 변경(영향 기준이 달라짐)
    const drift = await http.patch(`/api/schedule/${id}`).set(as('manager')).send({ durationMinutes: 120 }).expect(409);
    await http.patch(`/api/schedule/${id}`).set(as('manager'))
      .send({ durationMinutes: 120, acknowledgeAccountingImpact: true, expectedAccountingImpactHash: drift.body.impactHash }).expect(200);
    // 옛 hash로 ack — 409 + 최신 hash 재발급(60→90이 아니라 120→90 기준)
    const staleRetry = await http.patch(`/api/schedule/${id}`).set(as('manager'))
      .send({ durationMinutes: 90, acknowledgeAccountingImpact: true, expectedAccountingImpactHash: first.body.impactHash }).expect(409);
    expect(staleRetry.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    expect(staleRetry.body.impactHash).not.toBe(first.body.impactHash);
    expect(staleRetry.body.impact.delta.teachingMinutes).toBe(-30); // 120→90 기준으로 재계산됨
    await http.patch(`/api/schedule/${id}`).set(as('manager'))
      .send({ durationMinutes: 90, acknowledgeAccountingImpact: true, expectedAccountingImpactHash: staleRetry.body.impactHash }).expect(200);
  });

  it('③ force(충돌 강행)는 회계 확인을 우회하지 못한다 — 독립 옵션', async () => {
    const id = await makeHeldSession('10:00', 2);
    const res = await http.patch(`/api/schedule/${id}`).set(as('manager'))
      .send({ durationMinutes: 90, force: true }).expect(409);
    expect(res.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
  });

  it('④ 정산 연결 세션 update — PAYOUT_REVERSAL_REQUIRED에도 impactHash 동봉(계약 대칭)', async () => {
    // 픽스처 6월 완결 회차로 정산 생성(auto) — 연결된 회차 update 시도
    const preview = (await http.get('/api/payouts/preview?instructorId=1&from=2026-06-01&to=2026-06-30').set(as('admin')).expect(200)).body;
    expect(preview.sessionCount).toBeGreaterThan(0);
    const payout = (await http.post('/api/payouts/generate').set(as('admin'))
      .send({ instructorId: 1, from: '2026-06-01', to: '2026-06-30' }).expect(201)).body;
    const lockedSessionId = payout.lines[0].sessionId as number;
    const res = await http.patch(`/api/schedule/${lockedSessionId}`).set(as('manager'))
      .send({ durationMinutes: 90, acknowledgeAccountingImpact: true }).expect(409);
    expect(res.body.code).toBe('PAYOUT_REVERSAL_REQUIRED');
    expect(res.body.impactHash).toMatch(/^[a-f0-9]{64}$/);
    await http.post(`/api/payouts/${payout.id}/reject`).set(as('admin')).send({ reason: '74D-0 정리' }).expect(201); // 잔존 정리(후속 케이스 오염 방지)
  });

  it('⑤ 반복 update 요청: 생성 snapshot(impactSessionIds) ↔ 승인 잠금 후 대상 drift = REQUEST_SCOPE_STALE 전체 rollback', async () => {
    // 과거 시리즈 3회차(강사 요청·매니저 승인 흐름)
    const series = (await http.post('/api/schedule/series').set(as('manager')).send({
      courseId: 10, instructorId: 1, studentIds: [1], startTime: '11:00', durationMinutes: 60,
      repeat: { kind: 'weekly', weekdays: [new Date(`${PAST}T00:00:00Z`).getUTCDay()], startsOn: PAST, endsOn: addDaysISO(PAST, 14) },
      force: true,
    }).expect(201)).body;
    const rowIds = (series.rows as Array<{ id: number }>).map((r) => r.id);
    expect(rowIds.length).toBe(3);
    // 강사가 scope=all 시간 변경 요청 — snapshot에 3회차 전부 담긴다
    const reqRow = (await http.post('/api/schedule-requests').set(as('park_inst')).send({
      requestKind: 'session_update', targetSessionId: rowIds[0], sessionDate: PAST, startTime: '12:00', endTime: '13:00', scope: 'all',
      requestReason: '74D-0 scope drift 검증',
    }).expect(201)).body.row;
    expect([...reqRow.impactSessionIds].sort((a: number, b: number) => a - b)).toEqual([...rowIds].sort((a, b) => a - b));
    // 승인 전 시리즈 마지막 회차 삭제 — 대상 drift 발생
    await http.delete(`/api/schedule/${rowIds[2]}`).set(as('manager')).expect(200);
    const stale = await http.post(`/api/schedule-requests/${reqRow.id}/approve?forceConflicts=true`).set(as('manager')).expect(409);
    expect(stale.body.code).toBe('REQUEST_SCOPE_STALE');
    // 전체 rollback — 남은 두 회차 시간 무변 + 요청은 pending 유지(재요청 가능 상태)
    for (const sid of [rowIds[0], rowIds[1]]) {
      expect((await http.get(`/api/schedule/${sid}`).set(as('manager')).expect(200)).body.startTime).toBe('11:00');
    }
    const listAfterStale = (await http.get('/api/schedule-requests').set(as('manager')).expect(200)).body as Array<{ id: number; status: string }>;
    expect(listAfterStale.find((r) => r.id === reqRow.id)?.status).toBe('pending'); // 단건 GET 라우트 없음 — 목록으로 판정
    // 현재 범위 기준 새 요청은 승인 성공(2회차 전부 12:00)
    const fresh = (await http.post('/api/schedule-requests').set(as('park_inst')).send({
      requestKind: 'session_update', targetSessionId: rowIds[0], sessionDate: PAST, startTime: '12:00', endTime: '13:00', scope: 'all',
      requestReason: '74D-0 재요청',
    }).expect(201)).body.row;
    await http.post(`/api/schedule-requests/${fresh.id}/approve?forceConflicts=true`).set(as('manager')).expect(201); // 픽스처 절대 날짜 세션과의 시간 충돌은 이 검증의 관심사 아님(강제)
    for (const sid of [rowIds[0], rowIds[1]]) {
      expect((await http.get(`/api/schedule/${sid}`).set(as('manager')).expect(200)).body.startTime).toBe('12:00');
    }
  });
});
