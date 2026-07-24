// [TBO-62 2026-07-24] 긴급 수정 회귀 스위트 — 대표 운영 QA 6건 중 서버 검증 대상 3건.
//  ④ 강사 본인 출결 체크(최초 1회) — 수정·타인 세션은 403, 매니저는 PATCH로 자유 변경.
//  ⑤ 출결 기록 = 진행 사실의 단일 진실원 — 시작 지난 scheduled 세션 자동 held(시수·보강 오분류 해소),
//     미래 세션·종결 상태(canceled)는 전이하지 않음.
//  ⑥ 강사 payouts 표면 = 지급 완료(paid)만 — me 목록 필터·단건 403·preview/readiness 라우트 404.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mondayISO, addDaysISO } from './setup-app';

describe('[TBO-62] 긴급 수정 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const MON = mondayISO();

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst', 'jung_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  const makeSession = async (over: Record<string, unknown> = {}) =>
    (await http.post('/api/schedule').set(auth('admin')).send({
      courseId: 10, instructorId: 1, studentIds: [1], sessionDate: MON,
      startTime: '08:00', durationMinutes: 60, force: true, ...over,
    }).expect(201)).body.row;

  it('④ 강사 본인 출결 — 최초 1회 200, 재체크 403, 타인 세션 403, 매니저 PATCH는 자유', async () => {
    const row = await makeSession();
    // park_inst(강사1) 본인 세션 최초 체크 → 성공
    const marked = (await http.post(`/api/schedule/${row.id}/instructor-attendance`)
      .set(auth('park_inst')).send({ status: 'present' }).expect(201)).body;
    expect(marked.row.instructorAttendance).toBe('present');
    // 이미 체크됨 → 강사 재체크 403(수정은 매니저)
    await http.post(`/api/schedule/${row.id}/instructor-attendance`)
      .set(auth('park_inst')).send({ status: 'late' }).expect(403);
    // 타 강사(jung_inst) → 403
    const other = await makeSession({ startTime: '09:10' });
    await http.post(`/api/schedule/${other.id}/instructor-attendance`)
      .set(auth('jung_inst')).send({ status: 'present' }).expect(403);
    // 매니저는 PATCH로 자유 변경·초기화(종전 규약 유지)
    await http.patch(`/api/schedule/${row.id}`).set(auth('manager'))
      .send({ instructorAttendance: 'late', force: true }).expect(200);
    await http.patch(`/api/schedule/${row.id}`).set(auth('manager'))
      .send({ clearInstructorAttendance: true, force: true }).expect(200);
    // 초기화 후엔 강사가 다시 최초 체크 가능
    await http.post(`/api/schedule/${row.id}/instructor-attendance`)
      .set(auth('park_inst')).send({ status: 'present' }).expect(201);
  });

  it('⑤ 출결 기록 시 시작 지난 scheduled → held 자동 전이(시수·보강 오분류 해소)', async () => {
    // 과거(어제) 세션 — 관리자가 만들고 status는 scheduled 그대로인 운영 실측 시나리오 재현
    const past = await makeSession({ sessionDate: addDaysISO(MON, -7), startTime: '07:00' });
    expect(past.status).toBe('scheduled');
    await http.put('/api/attendance').set(auth('admin'))
      .send({ sessionId: past.id, studentId: 1, status: 'present' }).expect(200);
    const after = (await http.get(`/api/schedule?from=${addDaysISO(MON, -7)}&to=${addDaysISO(MON, -7)}`)
      .set(auth('admin')).expect(200)).body.find((r: { id: number }) => r.id === past.id);
    expect(after.status).toBe('held'); // 출결 기록 = 진행 사실 — 시수 인정·보강 오분류 해소의 단일 진실원
  });

  it('⑤-경계 미래 세션·종결 상태는 전이하지 않는다', async () => {
    const future = await makeSession({ sessionDate: addDaysISO(MON, 21), startTime: '10:00' });
    await http.put('/api/attendance').set(auth('admin'))
      .send({ sessionId: future.id, studentId: 1, status: 'present' }).expect(200);
    const stillScheduled = (await http.get(`/api/schedule?from=${addDaysISO(MON, 21)}&to=${addDaysISO(MON, 21)}`)
      .set(auth('admin')).expect(200)).body.find((r: { id: number }) => r.id === future.id);
    expect(stillScheduled.status).toBe('scheduled'); // 시작 전 — 실수 마킹이 미래 수업을 진행 처리하지 않음
    const canceled = await makeSession({ sessionDate: addDaysISO(MON, -6), startTime: '07:00' });
    await http.patch(`/api/schedule/${canceled.id}`).set(auth('admin')).send({ status: 'canceled', force: true }).expect(200);
    await http.put('/api/attendance').set(auth('admin'))
      .send({ sessionId: canceled.id, studentId: 1, status: 'present' }).expect(200);
    const stillCanceled = (await http.get(`/api/schedule?from=${addDaysISO(MON, -6)}&to=${addDaysISO(MON, -6)}`)
      .set(auth('admin')).expect(200)).body.find((r: { id: number }) => r.id === canceled.id);
    expect(stillCanceled.status).toBe('canceled'); // 종결 상태는 절대 덮지 않음
  });

  it('③-후속 부분 patch = 부분 검증 — 레거시 미비 원부도 매니저 퇴원 처리 200(필수 비우기만 400)', async () => {
    // 픽스처 학생 1은 gender·address·counselTopic 등이 비어 있는 레거시 형태 — 종전엔 status만
    //  바꿔도 완전-필수 검증 400("필수 학생 정보가 누락되었습니다")으로 퇴원 처리가 불가했다(운영 실측).
    const w = (await http.patch('/api/students/1').set(auth('manager')).send({ status: 'withdrawn' }).expect(200)).body;
    expect(w.status).toBe('withdrawn');
    const back = (await http.patch('/api/students/1').set(auth('manager')).send({ status: 'enrolled' }).expect(200)).body;
    expect(back.status).toBe('enrolled');
    // 필수 필드를 빈 값으로 지우는 patch는 여전히 400(계약 유지)
    const clear = await http.patch('/api/students/1').set(auth('manager')).send({ name: ' ' });
    expect(clear.status).toBe(400);
    expect(clear.body.message).toContain('비울 수 없습니다');
  });

  it('⑥ 강사 payouts = paid만 — me 필터·단건 403·산정 라우트 404', async () => {
    // 픽스처 정산 1건은 jung_inst(강사2) 소유 pending — 강사2 me 목록은 paid만이라 빈 배열
    const mine = (await http.get('/api/payouts/me').set(auth('jung_inst')).expect(200)).body;
    expect(mine.every((p: { status: string }) => p.status === 'paid')).toBe(true);
    // 본인 소유라도 지급 전(pending) 단건은 403(지급 전 산정 내역 비노출)
    const all = (await http.get('/api/payouts').set(auth('admin')).expect(200)).body;
    const pending = all.find((p: { status: string; instructorId: number }) => p.status !== 'paid' && p.instructorId === 2);
    if (pending) await http.get(`/api/payouts/${pending.id}`).set(auth('jung_inst')).expect(403);
    // 시수 산정·누락 라우트는 강사에게 존재하지 않음(404 — 라우트 삭제)
    await http.get('/api/payouts/me/preview').query({ from: '2026-07-01', to: '2026-07-31' })
      .set(auth('jung_inst')).expect(404);
    await http.get('/api/payouts/me/readiness').set(auth('jung_inst')).expect(404);
  });
});
