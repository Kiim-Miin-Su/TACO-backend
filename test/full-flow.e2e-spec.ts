import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mondayISO, addDaysISO } from './setup-app';

// ─────────────────────────────────────────────────────────────
// 전체 플로우 통합 e2e — 관리자 로그인 → 스케줄 생성(독립·커스텀 반복) →
//   가용/불가 설정 → 충돌 있는/없는 생성 → 진행(held) → 리포트 작성·승인 →
//   페이 계산 → 스케줄 삭제(독립·시리즈) → 페이 반영 검증.
// + 추가: 미승인 보고서 제외 · 취소 세션 제외 · 이중계상 방지 · 권한 게이트.
//
// 시드(현재·과거 주)와 겹치지 않도록 미래 주(구간)에서 실행해 격리.
// 코스10=SAT Reading(강사1, 시급 50,000/h), 수강생={학생1,4}. 90분 → 75,000.
// ─────────────────────────────────────────────────────────────
describe('Full Flow (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  const MON = mondayISO();
  const W3MON = addDaysISO(MON, 21);          // 메인 플로우 주(3주 뒤)
  const W3TUE = addDaysISO(W3MON, 1);
  const W3SUN = addDaysISO(W3MON, 6);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const login = await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    ADMIN = login.body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  // 1) 로그인
  it('1) 관리자 로그인 → 토큰 발급', () => {
    expect(ADMIN).toBeTruthy();
  });

  // 2) 독립 스케줄 생성(충돌 없음)
  let S1 = 0;
  it('2) 독립 스케줄 생성(강사1 화 10:00, 충돌 없음) → 201', async () => {
    const res = await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: W3TUE, startTime: '10:00', durationMinutes: 90 })
      .expect(201);
    S1 = res.body.row.id;
    expect(S1).toBeGreaterThan(0);
    expect(res.body.conflicts).toEqual([]);
  });

  // 3) 커스텀 반복(같은 seriesId, 3회)
  const seriesId = Date.now();
  const seriesIds: number[] = [];
  it('3) 커스텀 반복 시리즈 생성(화 14:00, 매주 3회, 같은 seriesId)', async () => {
    for (const d of [W3TUE, addDaysISO(W3TUE, 7), addDaysISO(W3TUE, 14)]) {
      const res = await http.post('/api/schedule').set(asAdmin())
        .send({ courseId: 10, instructorId: 1, sessionDate: d, startTime: '14:00', durationMinutes: 90, seriesId })
        .expect(201);
      seriesIds.push(res.body.row.id);
    }
    expect(seriesIds).toHaveLength(3);
  });

  // 4) 가용/불가 설정 — 강사1 화요일(빈 요일) 16:00–17:00 불가
  it('4) 강사1 불가시간 설정(화 16:00–17:00) → 200', async () => {
    await http.put('/api/availability')
      .send({ ownerType: 'instructor', ownerId: 1, kind: 'unavailable', weekday: 2, startTime: '16:00', endTime: '17:00' })
      .expect(200);
  });

  // 5) 충돌 있는/없는 생성 시도 + 응답
  it('5a) 불가시간과 겹치는 생성 → 409 (unavailable, 실데이터 메시지)', async () => {
    const res = await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: W3TUE, startTime: '16:00', durationMinutes: 60 })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('unavailable');
  });
  it('5b) force=true면 강제 생성 → 201 (충돌은 보고됨)', async () => {
    const res = await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: W3TUE, startTime: '16:00', durationMinutes: 60, force: true })
      .expect(201);
    expect(res.body.conflicts.length).toBeGreaterThan(0);
  });
  it('5c) 강사 이중예약(S1과 같은 화 10:00) → 409 double_book', async () => {
    const res = await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: W3TUE, startTime: '10:00', durationMinutes: 90 })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('double_book');
  });
  it('5d) 충돌 없는 슬롯(화 19:00) → 201', async () => {
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: W3TUE, startTime: '19:00', durationMinutes: 60 })
      .expect(201);
  });

  // 6) 진행(held)으로 상태 변경
  it('6) S1 수업 진행(held)으로 상태 변경 → 200', async () => {
    await http.patch(`/api/schedule/${S1}`).set(asAdmin()).send({ status: 'held', force: true }).expect(200);
  });

  // 7) 리포트 작성 + 승인 (수강생 학생1)
  let reportId = 0;
  it('7) 리포트 작성(submitted) + 관리자 승인 → approved', async () => {
    const r = await http.post('/api/reports')
      .send({ sessionId: S1, studentId: 1, content: '진도: 추론 문제. 정답률 향상.' }).expect(201);
    reportId = r.body.id;
    expect(r.body.status).toBe('submitted');
    await http.post(`/api/reports/${reportId}/approve`).set(asAdmin()).expect(201)
      .then((res) => expect(res.body.status).toBe('approved'));
  });

  // 8) 페이 계산(preview) — held ∧ 승인 세션만
  it('8) 페이 미리보기: S1 적격, 75,000(90분×50,000/h)', async () => {
    const m = (await http.get(`/api/payouts/preview?instructorId=1&from=${W3MON}&to=${W3SUN}`).expect(200)).body;
    expect(m.lines.some((l: { sessionId: number }) => l.sessionId === S1)).toBe(true);
    const line = m.lines.find((l: { sessionId: number }) => l.sessionId === S1);
    expect(line).toMatchObject({ hourlyRate: 50000, durationMinutes: 90, amount: 75000 });
    expect(m.sessionCount).toBe(1); // 시리즈·강제생성은 scheduled(미진행) → 제외
    expect(m.computedAmount).toBe(75000);
  });

  // 9) 페이 생성(generate) + 이중계상 방지
  let payoutId = 0;
  it('9) 페이 생성 → 세션 연결, 재산정 시 적격 0 → 400', async () => {
    const p = (await http.post('/api/payouts/generate').set(asAdmin()).send({ instructorId: 1, from: W3MON, to: W3SUN }).expect(201)).body;
    payoutId = p.id;
    expect(p.amount).toBe(75000);
    expect(p.sessionCount).toBe(1);
    await http.post('/api/payouts/generate').set(asAdmin()).send({ instructorId: 1, from: W3MON, to: W3SUN }).expect(400);
  });

  // 10) 반려로 세션 회수 → 재산정 가능
  it('10) 정산 반려 → 세션 회수, 다시 적격', async () => {
    await http.post(`/api/payouts/${payoutId}/reject`).set(asAdmin()).send({ reason: '재확인' }).expect(201);
    const m = (await http.get(`/api/payouts/preview?instructorId=1&from=${W3MON}&to=${W3SUN}`).expect(200)).body;
    expect(m.sessionCount).toBe(1);
  });

  // 11) 독립 스케줄 삭제 → 페이 미반영(시수 미측정)
  it('11) S1 삭제 → 페이 미리보기에서 사라짐(시수 0)', async () => {
    await http.delete(`/api/schedule/${S1}`).set(asAdmin()).expect(200);
    const m = (await http.get(`/api/payouts/preview?instructorId=1&from=${W3MON}&to=${W3SUN}`).expect(200)).body;
    expect(m.lines.some((l: { sessionId: number }) => l.sessionId === S1)).toBe(false);
    expect(m.sessionCount).toBe(0);
  });

  // 12) 커스텀 반복 시리즈 삭제(3건)
  it('12) 커스텀 반복 시리즈 삭제(3건) → 목록에서 사라짐', async () => {
    for (const id of seriesIds) {
      await http.delete(`/api/schedule/${id}`).set(asAdmin()).expect(200);
    }
    const list = (await http.get(`/api/schedule?from=${W3MON}&to=${addDaysISO(W3MON, 28)}`).expect(200)).body;
    expect(list.some((r: { id: number }) => seriesIds.includes(r.id))).toBe(false);
  });

  // ── 추가 흐름 ──
  it('13) 미승인 보고서는 시수 미측정(제출만 → preview 0)', async () => {
    const w4mon = addDaysISO(MON, 28), w4tue = addDaysISO(w4mon, 1), w4sun = addDaysISO(w4mon, 6);
    const s = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: w4tue, startTime: '10:00', durationMinutes: 90 }).expect(201)).body.row;
    await http.patch(`/api/schedule/${s.id}`).set(asAdmin()).send({ status: 'held', force: true }).expect(200);
    await http.post('/api/reports').send({ sessionId: s.id, studentId: 1, content: '미승인' }).expect(201); // submitted, 미승인
    const m = (await http.get(`/api/payouts/preview?instructorId=1&from=${w4mon}&to=${w4sun}`).expect(200)).body;
    expect(m.sessionCount).toBe(0);
  });

  it('14) 취소(canceled) 세션은 시수 미측정(승인 보고서 있어도)', async () => {
    const w5mon = addDaysISO(MON, 35), w5tue = addDaysISO(w5mon, 1), w5sun = addDaysISO(w5mon, 6);
    const s = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: w5tue, startTime: '10:00', durationMinutes: 90 }).expect(201)).body.row;
    await http.patch(`/api/schedule/${s.id}`).set(asAdmin()).send({ status: 'held', force: true }).expect(200);
    const r = (await http.post('/api/reports').send({ sessionId: s.id, studentId: 1, content: 'ok' }).expect(201)).body;
    await http.post(`/api/reports/${r.id}/approve`).set(asAdmin()).expect(201);
    // 진행 상태였다가 취소로 변경 → 시수 제외
    await http.patch(`/api/schedule/${s.id}`).set(asAdmin()).send({ status: 'canceled', force: true }).expect(200);
    const m = (await http.get(`/api/payouts/preview?instructorId=1&from=${w5mon}&to=${w5sun}`).expect(200)).body;
    expect(m.sessionCount).toBe(0);
  });

  it('15) 권한: 비로그인 정산 생성 401 · 강사(instructor) 403', async () => {
    await http.post('/api/payouts/generate').send({ instructorId: 1, from: W3MON, to: W3SUN }).expect(401);
    const login = await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201);
    await http.post('/api/payouts/generate').set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({ instructorId: 1, from: W3MON, to: W3SUN }).expect(403);
  });
});
