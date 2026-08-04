// [TBO-76 E 2026-07-29] held 자동 전이 = 강사 출결 + 대상 학생 전원 출결 완결.
// 보고서 승인이나 일부 출결은 출결 사실을 대체하지 않으며, 종료된 미완결 회차는 서버 파생 뱃지로 노출한다.
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

  it('강사 출결 요청은 차단되고 대표가 강사·학생 출결을 완결하면 held 전이', async () => {
    const id = await makePastSession('08:00');
    await http.put(`/api/schedule/${id}/instructor-attendance`).set(auth('park_inst')).send({ status: 'present' }).expect(403);
    await http.put(`/api/schedule/${id}/instructor-attendance`).set(auth('admin')).send({ status: 'present' }).expect(200);
    expect(await statusOf(id)).toBe('scheduled');
    const incomplete = (await http.get(`/api/schedule/${id}`).set(auth('admin')).expect(200)).body;
    expect(incomplete).toMatchObject({
      attendanceRequired: true,
      missingAttendance: { instructor: false, studentIds: [1] },
    });
    await http.put('/api/attendance').set(auth('admin')).send({ sessionId: id, studentId: 1, status: 'present' }).expect(200);
    expect(await statusOf(id)).toBe('held');
  });

  it('매니저 강사 출결 PATCH는 차단되고 대표의 명시 status는 우선한다', async () => {
    const id = await makePastSession('09:00');
    await http.patch(`/api/schedule/${id}`).set(auth('manager')).send({ instructorAttendance: 'late', force: true }).expect(400);
    await http.put(`/api/schedule/${id}/instructor-attendance`).set(auth('admin')).send({ status: 'late' }).expect(200);
    expect(await statusOf(id)).toBe('scheduled');
    // status 명시 동반이면 수동 지정 존중(자동 전이가 덮지 않음)
    const id2 = await makePastSession('10:00');
    await http.patch(`/api/schedule/${id2}`).set(auth('admin'))
      .send({ status: 'canceled', force: true, acknowledgeAccountingImpact: true }).expect(200);
    await http.put(`/api/schedule/${id2}/instructor-attendance`).set(auth('admin'))
      .send({ status: 'present' }).expect(200);
    expect(await statusOf(id2)).toBe('canceled');
  });

  it('리포트 승인은 출결을 대체하지 않고, 출결 완결 시에만 held 전이', async () => {
    const id = await makePastSession('11:00');
    const report = (await http.post('/api/reports').set(auth('admin'))
      .send({ sessionId: id, studentId: 1, content: '리포트만 작성된 회차' }).expect(201)).body;
    expect(await statusOf(id)).toBe('scheduled'); // 작성만으로는 전이 없음(승인이 사실 확정)
    await http.post(`/api/reports/${report.id}/approve`).set(auth('admin')).expect(201);
    expect(await statusOf(id)).toBe('scheduled');
    await http.put('/api/attendance').set(auth('admin')).send({ sessionId: id, studentId: 1, status: 'present' }).expect(200);
    expect(await statusOf(id)).toBe('scheduled');
    await http.put(`/api/schedule/${id}/instructor-attendance`).set(auth('admin')).send({ status: 'present' }).expect(200);
    expect(await statusOf(id)).toBe('held');
  });

  it('경계 — 미래 세션·종결 상태(canceled)는 어떤 경로로도 전이하지 않는다', async () => {
    const future = addDaysISO(mondayISO(), 21);
    const futureId = (await http.post('/api/schedule').set(auth('admin'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: future, startTime: '08:00', durationMinutes: 60, force: true })
      .expect(201)).body.row.id;
    await http.put(`/api/schedule/${futureId}/instructor-attendance`).set(auth('admin')).send({ status: 'present' }).expect(200);
    expect(await statusOf(futureId)).toBe('scheduled'); // 미래 — 전이 금지

    const canceledId = await makePastSession('12:00');
    await http.patch(`/api/schedule/${canceledId}`).set(auth('manager'))
      .send({ status: 'canceled', force: true }).expect(200);
    await http.put('/api/attendance').set(auth('admin')).send({ sessionId: canceledId, studentId: 1, status: 'present' }).expect(200);
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
    // 학생+강사 출결 완결 후 재조회 — 해당 회차는 실행 미확정에서 빠진다
    await http.put('/api/attendance').set(auth('admin')).send({ sessionId: id, studentId: 1, status: 'present' }).expect(200);
    await http.put(`/api/schedule/${id}/instructor-attendance`).set(auth('admin')).send({ status: 'present' }).expect(200);
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
