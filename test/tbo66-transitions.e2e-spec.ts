// [TBO-66 C1 2026-07-25] 자동 held 전이 3경로 + uncovered 실행 미확정 + no-store 헤더 e2e.
//  전이 진실원 autoHoldPatch: "사실 기록"(학생 출결·강사 출결·리포트 승인) 어느 것이든 시작 경과
//  scheduled 세션을 held로 확정. 경계(미래·종결 상태) 불변. — TBO-62 ⑤ 원 취지 완결 검증.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mondayISO, addDaysISO } from './setup-app';

describe('[TBO-66] 자동 전이·캐싱 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const PAST = addDaysISO(mondayISO(), -14); // 확실한 과거(2주 전 월요일)

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  const makePastSession = async (startTime: string) => {
    const res = await http.post('/api/schedule').set(auth('admin'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: PAST, startTime, durationMinutes: 60, force: true })
      .expect(201);
    expect(res.body.row.status).toBe('scheduled');
    return res.body.row.id as number;
  };
  const statusOf = async (id: number) =>
    (await http.get(`/api/schedule/${id}`).set(auth('admin')).expect(200)).body.status as string;

  it('경로 ① 강사 본인 출결 셀프 체크 → scheduled→held 자동 전이', async () => {
    const id = await makePastSession('08:00');
    await http.post(`/api/schedule/${id}/instructor-attendance`).set(auth('park_inst')).send({ status: 'present' }).expect(201);
    expect(await statusOf(id)).toBe('held');
  });

  it('경로 ① 매니저 강사 출결 PATCH → 자동 전이 (status 명시가 있으면 명시 우선)', async () => {
    const id = await makePastSession('09:00');
    await http.patch(`/api/schedule/${id}`).set(auth('manager')).send({ instructorAttendance: 'late', force: true }).expect(200);
    expect(await statusOf(id)).toBe('held');
    // status 명시 동반이면 수동 지정 존중(자동 전이가 덮지 않음)
    const id2 = await makePastSession('10:00');
    await http.patch(`/api/schedule/${id2}`).set(auth('manager'))
      .send({ instructorAttendance: 'present', status: 'canceled', force: true, acknowledgeAccountingImpact: true }).expect(200);
    expect(await statusOf(id2)).toBe('canceled');
  });

  it('경로 ② 리포트 승인 → 자동 전이(출결 없이 리포트만 승인된 세션도 held 확정)', async () => {
    const id = await makePastSession('11:00');
    const report = (await http.post('/api/reports').set(auth('admin'))
      .send({ sessionId: id, studentId: 1, content: '리포트만 작성된 회차' }).expect(201)).body;
    expect(await statusOf(id)).toBe('scheduled'); // 작성만으로는 전이 없음(승인이 사실 확정)
    await http.post(`/api/reports/${report.id}/approve`).set(auth('admin')).expect(201);
    expect(await statusOf(id)).toBe('held');
  });

  it('경계 — 미래 세션·종결 상태(canceled)는 어떤 경로로도 전이하지 않는다', async () => {
    const future = addDaysISO(mondayISO(), 21);
    const futureId = (await http.post('/api/schedule').set(auth('admin'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: future, startTime: '08:00', durationMinutes: 60, force: true })
      .expect(201)).body.row.id;
    await http.patch(`/api/schedule/${futureId}`).set(auth('manager')).send({ instructorAttendance: 'present', force: true }).expect(200);
    expect(await statusOf(futureId)).toBe('scheduled'); // 미래 — 전이 금지

    const canceledId = await makePastSession('12:00');
    await http.patch(`/api/schedule/${canceledId}`).set(auth('manager'))
      .send({ status: 'canceled', force: true }).expect(200);
    await http.put('/api/attendance').set(auth('manager')).send({ sessionId: canceledId, studentId: 1, status: 'present' }).expect(200);
    expect(await statusOf(canceledId)).toBe('canceled'); // 종결 상태 불변(학생 출결 경로)
  });

  it('T2 — uncovered가 실행 미확정(종료 경과 scheduled)을 executionMissingCount로 계상한다', async () => {
    const id = await makePastSession('13:00'); // 과거 scheduled — 출결·리포트 아무것도 없음
    const entries = (await http.get('/api/payouts/uncovered?months=3').set(auth('admin')).expect(200)).body as Array<{
      instructorId: number; month: string; executionMissingCount: number; sessionCount: number;
    }>;
    const month = PAST.slice(0, 7);
    const entry = entries.find((e) => e.instructorId === 1 && e.month === month);
    expect(entry).toBeDefined();
    expect(entry!.executionMissingCount).toBeGreaterThan(0); // 위 세션 포함(이 스위트가 만든 잔여 scheduled들)
    // 출결 기록(자동 전이) 후 재조회 — 해당 회차는 실행 미확정에서 빠진다
    await http.put('/api/attendance').set(auth('admin')).send({ sessionId: id, studentId: 1, status: 'present' }).expect(200);
    const after = (await http.get('/api/payouts/uncovered?months=3').set(auth('admin')).expect(200)).body as typeof entries;
    const afterEntry = after.find((e) => e.instructorId === 1 && e.month === month);
    expect((afterEntry?.executionMissingCount ?? 0)).toBeLessThan(entry!.executionMissingCount);
  });

  it('R4 — 전 API 응답 Cache-Control: no-store(인증 데이터 브라우저 캐시 차단)', async () => {
    const res = await http.get('/api/schedule').set(auth('admin')).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const anon = await http.get('/api/health');
    expect(anon.headers['cache-control']).toBe('no-store'); // 미들웨어 전역(경로 무관)
  });
});
