import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Enrollment } from '../src/modules/enrollments/enrollment.entity';
import type { SessionReportRow } from '../src/modules/reports/report.entity';
import type { ClassSession } from '../src/modules/schedule/schedule.entity';
import { evaluatePayoutReadiness } from '../src/modules/payouts/payout-readiness.policy';
import { createTestApp } from './setup-app';

const session = (over: Partial<ClassSession> = {}): ClassSession => ({
  id: 7001,
  courseId: 10,
  instructorId: 1,
  studentIds: [1, 4],
  sessionDate: '2026-07-01',
  startTime: '10:00',
  endTime: '11:00',
  durationMinutes: 60,
  status: 'held',
  kind: 'class',
  mode: 'in_person',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  ...over,
} as ClassSession);

const enrollment = (studentId: number): Enrollment => ({
  id: studentId,
  studentId,
  courseId: 10,
  status: 'active',
  enrolledAt: '2026-01-01',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as Enrollment);

const report = (studentId: number, approvalStatus: SessionReportRow['approvalStatus']): SessionReportRow => ({
  id: 8000 + studentId,
  sessionId: 7001,
  studentId,
  instructorId: 1,
  content: '수업 기록',
  status: approvalStatus === 'draft' ? 'draft' : 'submitted',
  approvalStatus,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
} as SessionReportRow);

const evaluate = (reports: SessionReportRow[], sessions: ClassSession[] = [session()]) => evaluatePayoutReadiness({
  sessions,
  enrollments: [enrollment(1), enrollment(4)],
  reports,
  periodStart: '2026-07-01',
  periodEnd: '2026-07-31',
  instructorId: 1,
  effectiveRateOf: () => 50_000,
  nowDate: '2026-07-21',
  nowTime: '12:00',
});

describe('시수·페이 준비 정책', () => {
  it('한 학생 보고서만 승인되면 나머지 학생 1건을 누락으로 반환하고 정산에서 제외한다', () => {
    const result = evaluate([report(1, 'approved')]);
    expect(result.eligibleSessionIds).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({ id: 'report:7001:4', type: 'report_missing', sessionId: 7001, studentId: 4 }),
    ]);
  });

  it('대상 학생별 상태를 각각 한 건으로 반환하고 전원 승인된 경우에만 적격이다', () => {
    const blocked = evaluate([report(1, 'submitted'), report(4, 'rejected')]);
    expect(blocked.issues.map((item) => [item.type, item.studentId])).toEqual([
      ['report_pending_approval', 1],
      ['report_rejected', 4],
    ]);
    expect(evaluate([report(1, 'approved'), report(4, 'approved')]).eligibleSessionIds).toEqual([7001]);
  });

  it('지난 scheduled는 실행 미확정 1건, 취소 세션은 보강 정책 책임이라 중복 알림하지 않는다', () => {
    const result = evaluate([], [
      session({ id: 7002, status: 'scheduled', studentIds: [1] }),
      session({ id: 7003, status: 'canceled', studentIds: [1] }),
    ]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ type: 'session_execution_missing', sessionId: 7002 });
  });
});

describe('시수·페이 준비 API 권한', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });

  afterAll(async () => app.close());

  it('준비 상태(readiness)는 매니저 이상 전용 — 강사는 전량 차단(TBO-62 ⑥)', async () => {
    await http.get('/api/payouts/readiness?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${tokens.manager}`).expect(200);
    await http.get('/api/payouts/readiness?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${tokens.park_inst}`).expect(403);
    // [TBO-62 ⑥ 2026-07-24] 강사용 me/readiness 라우트 자체 제거(대표 지시: 강사는 받은 내역만) → 404.
    await http.get('/api/payouts/me/readiness?from=2026-06-01&to=2026-06-30')
      .set('Authorization', `Bearer ${tokens.park_inst}`).expect(404);
  });

  it('잘못된 달력 날짜는 readiness 조회 전에 400으로 거부한다', async () => {
    await http.get('/api/payouts/readiness?from=2026-99-01&to=2026-07-31')
      .set('Authorization', `Bearer ${tokens.manager}`).expect(400);
  });
});
