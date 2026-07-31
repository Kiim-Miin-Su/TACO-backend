// [TBO-80 80J F-2] 강사 본인 비금전 readiness 라우트 — 배지 소스 복원 회귀.
//  이빨: 이 라우트는 TBO-62에서 제거됐던 것(수정 전 코드에서 ① 404·⑤ 403 확인) — 시뮬레이션 QA가
//  "held+리포트 0건인데 강사 보고서 배지 0"으로 죽은 소비처를 실측해 복원했다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { completeSessionByAttendance, createTestApp } from './setup-app';

describe('GET /payouts/me/readiness — 강사 배지 소스(비금전) (TBO-80 80J)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst', 'jung_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('① 라우트 실재 + 본인 스코프: held·리포트 미작성 세션의 report_missing이 학생별로 반환된다', async () => {
    // park_inst(1) 담당 과거 세션 생성 → 출결 사실로 held 전이(직접 held 주입 금지 규약)
    const s = (await http.post('/api/schedule').set(auth('admin')).send({
      courseId: 10, instructorId: 1, studentIds: [1], sessionDate: '2026-07-02',
      startTime: '08:00', durationMinutes: 60, force: true,
    }).expect(201)).body.row;
    await completeSessionByAttendance(http, auth('admin'), s.id, [1]);

    const mine = (await http.get('/api/payouts/me/readiness').set(auth('park_inst')).expect(200)).body;
    const missing = (mine.issues as Array<Record<string, unknown>>).filter(
      (row) => row.type === 'report_missing' && row.sessionId === s.id,
    );
    expect(missing).toHaveLength(1); // (session, student)당 정확히 1건
    expect(missing[0].studentId).toBe(1);
    expect(mine.issueCount).toBe(mine.issues.length);
  });

  it('② 비금전 보장: rate_missing은 관리자 readiness에는 있어도 me/readiness에는 없다', async () => {
    // 시급 소스가 없는 강사(2, jung_inst — 기본 시급 미설정 시드)와 override 없는 코스로 held 생성
    const s = (await http.post('/api/schedule').set(auth('admin')).send({
      courseId: 11, instructorId: 2, studentIds: [2], sessionDate: '2026-07-02',
      startTime: '09:30', durationMinutes: 60, force: true,
    }).expect(201)).body.row;
    await completeSessionByAttendance(http, auth('admin'), s.id, [2]);
    // 리포트 승인까지 완료 → 남는 이슈가 있다면 rate 축뿐인 상태를 만든다
    const rep = (await http.post('/api/reports').set(auth('admin'))
      .send({ sessionId: s.id, studentId: 2, content: '레이트 축 검증 본문' }).expect(201)).body;
    await http.post(`/api/reports/${rep.id}/submit`).set(auth('admin')).expect(201);
    await http.post(`/api/reports/${rep.id}/approve`).set(auth('admin')).expect(201);

    const adminView = (await http.get('/api/payouts/readiness').set(auth('admin'))
      .query({ instructorId: 2 }).expect(200)).body;
    const adminRate = (adminView.issues as Array<Record<string, unknown>>)
      .filter((row) => row.type === 'rate_missing' && row.sessionId === s.id);
    const mine = (await http.get('/api/payouts/me/readiness').set(auth('jung_inst')).expect(200)).body;
    const mineRate = (mine.issues as Array<Record<string, unknown>>).filter((row) => row.type === 'rate_missing');
    // 관리자 뷰가 rate_missing을 만들었을 때만 의미 있는 대조(시드 변동 방어) — me는 항상 0이어야 한다
    expect(mineRate).toHaveLength(0);
    if (adminRate.length === 0) {
      // 시드에 기본 시급이 있어 rate 이슈가 안 생기면, 필터 자체를 단위로 재확인
      expect(mine.issues.every((row: { type: string }) => row.type !== 'rate_missing')).toBe(true);
    }
  });

  it('③ 시수 메타 비노출: eligibleSessionIds는 항상 빈 배열', async () => {
    const mine = (await http.get('/api/payouts/me/readiness').set(auth('park_inst')).expect(200)).body;
    expect(mine.eligibleSessionIds).toEqual([]);
  });

  it('④ 본인 스코프: 타 강사 이슈가 섞이지 않는다', async () => {
    const mine = (await http.get('/api/payouts/me/readiness').set(auth('park_inst')).expect(200)).body;
    expect((mine.issues as Array<{ instructorId: number }>).every((row) => row.instructorId === 1)).toBe(true);
  });

  it('⑤ 권한 경계 유지: 강사의 전체 readiness는 여전히 403, 관리자 me/readiness는 role 불일치 403', async () => {
    await http.get('/api/payouts/readiness').set(auth('park_inst')).expect(403);
    await http.get('/api/payouts/me/readiness').set(auth('manager')).expect(403);
    await http.get('/api/payouts/me/readiness').expect(401);
  });
});
