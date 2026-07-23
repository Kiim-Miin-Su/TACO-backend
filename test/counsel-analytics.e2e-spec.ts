// [TBO-30D/30E 2026-07-23] 상담 퍼널·상관관계 — **순수 함수 단일 진실원** 검증.
//  ① 순수 함수에 결정적 스냅샷을 주입해 기대 수치를 고정(payout-integrity 음성 검증과 같은 규약 —
//     API와 같은 함수를 직접 소비하므로 집계 로직 사본 0).
//  ② API 배선: 픽스처 수치 고정 + 기간 검증 400 + 역할 게이트(강사 403).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import {
  CORRELATION_CUSTOM_KEY, CORRELATION_NONE_KEY,
  computeCounselCorrelation, computeCounselFunnel, type CounselAnalyticsSnapshot,
} from '../src/modules/counsel/counsel-analytics';

// ── ① 순수 함수 — 결정적 스냅샷 ─────────────────────────────
const snapshot = (): CounselAnalyticsSnapshot => ({
  forms: [
    { id: 1, studentId: 1, status: 'requested', createdAt: '2026-07-01T00:00:00Z' }, // 접수만(0회차)
    { id: 2, studentId: 2, status: 'pending', createdAt: '2026-07-02T00:00:00Z' },   // 1회차 진행
    { id: 3, studentId: 3, status: 'registered', createdAt: '2026-07-03T00:00:00Z' },// 2회차째 전환
    { id: 4, studentId: 4, status: 'dropped', createdAt: '2026-07-04T00:00:00Z' },   // 1회차 후 이탈
    { id: 5, studentId: 5, status: 'requested', createdAt: '2026-06-01T00:00:00Z' }, // 기간 밖(6월)
  ],
  rounds: [
    { counselFormId: 2, roundNo: 0, result: 'positive', completedAt: '2026-07-05' },
    { counselFormId: 3, roundNo: 0, result: 'neutral', completedAt: '2026-07-06' },
    { counselFormId: 3, roundNo: 1, result: 'registered', completedAt: '2026-07-13' }, // 접수 07-03 → +10일
    { counselFormId: 4, roundNo: 0, result: 'negative', completedAt: '2026-07-07' },
  ],
  interests: [
    { studentId: 1, courseId: 10 },                       // 영어 희망
    { studentId: 3, courseId: 10 }, { studentId: 3, courseId: 12 }, // 영어 희망(같은 과목 2코스 — dedup)
    { studentId: 4, customLabel: '미술 입시' },            // 자유입력 버킷
    // studentId 2 — 희망 미입력 버킷
  ],
  enrollments: [
    { studentId: 3, courseId: 11, status: 'active' },     // 영어 희망 → 수학 등록(교차 전환)
    { studentId: 3, courseId: 12, status: 'canceled' },   // canceled 제외
    { studentId: 1, courseId: 10, status: 'active' },     // 미전환 카드 학생의 수강은 집계 제외
  ],
  courses: [{ id: 10, subjectId: 1 }, { id: 11, subjectId: 2 }, { id: 12, subjectId: 1 }],
  subjects: [{ id: 1, name: '영어' }, { id: 2, name: '수학' }],
});

const JULY = { from: '2026-07-01', to: '2026-07-31' };

describe('counsel-analytics 순수 함수 (TBO-30D/30E)', () => {
  it('퍼널 — 상태·도달·이탈 회차·전환율·평균 소요가 기대 수치로 고정', () => {
    const funnel = computeCounselFunnel(snapshot(), JULY);
    expect(funnel.total).toBe(4); // 6월 카드 제외(기간 필터)
    expect(funnel.statusCounts).toEqual({ requested: 1, pending: 1, registered: 1, dropped: 1 });
    expect(funnel.roundReach).toEqual([
      { minRounds: 0, count: 4 }, { minRounds: 1, count: 3 }, { minRounds: 2, count: 1 },
    ]);
    expect(funnel.dropAfterRounds).toEqual([{ rounds: 1, count: 1 }]); // 1회차에서 놓침
    expect(funnel.conversionRate).toBeCloseTo(0.25);
    expect(funnel.dropRate).toBeCloseTo(0.25);
    expect(funnel.avgRoundsToConversion).toBe(2); // roundNo 1 → 2회차째 전환
    expect(funnel.avgDaysToConversion).toBe(10);  // 07-03 접수 → 07-13 전환 회차
    expect(funnel.resultDistribution).toMatchObject({ positive: 1, neutral: 1, negative: 1, registered: 1, no_response: 0 });
  });

  it('퍼널 — 빈 기간은 0 기준선(율 0·평균 null)', () => {
    const funnel = computeCounselFunnel(snapshot(), { from: '2025-01-01', to: '2025-12-31' });
    expect(funnel.total).toBe(0);
    expect(funnel.conversionRate).toBe(0);
    expect(funnel.avgRoundsToConversion).toBeNull();
    expect(funnel.avgDaysToConversion).toBeNull();
  });

  it('상관관계 — 희망(관심 SSOT)×등록(enrollments) 조인: 교차 전환·dedup·특수 버킷·canceled 제외', () => {
    const correlation = computeCounselCorrelation(snapshot(), JULY);
    expect(correlation.totalForms).toBe(4);
    const byKey = Object.fromEntries(correlation.rows.map((row) => [row.interestKey, row]));
    // 영어 희망: 카드 2(학생1·학생3, 같은 과목 2코스는 dedup) → 전환 1(학생3) → 실제 등록은 수학(교차)
    expect(byKey['영어']).toMatchObject({ counselCount: 2, convertedCount: 1 });
    expect(byKey['영어'].conversionRate).toBeCloseTo(0.5);
    expect(byKey['영어'].enrolledBySubject).toEqual([{ subject: '수학', count: 1 }]); // canceled 영어는 제외
    // 자유입력·미입력 버킷
    expect(byKey[CORRELATION_CUSTOM_KEY]).toMatchObject({ counselCount: 1, convertedCount: 0 });
    expect(byKey[CORRELATION_NONE_KEY]).toMatchObject({ counselCount: 1, convertedCount: 0 });
    // 열 구성 — 등장한 등록 과목만
    expect(correlation.enrolledSubjects).toEqual(['수학']);
  });
});

// ── ② API 배선 — 픽스처 수치·검증·게이트 ─────────────────────
describe('GET /counsel/analytics/* (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin = '';
  let inst = '';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('funnel — 픽스처 수치 고정(전 3건·전환 1·2회차째 전환)', async () => {
    const funnel = (await http.get('/api/counsel/analytics/funnel').set(auth(admin)).expect(200)).body;
    expect(funnel.total).toBe(3);
    expect(funnel.statusCounts).toMatchObject({ requested: 1, pending: 1, registered: 1, dropped: 0 });
    expect(funnel.conversionRate).toBeCloseTo(1 / 3);
    expect(funnel.avgRoundsToConversion).toBe(2); // 픽스처 form2 — roundNo 1에서 result=registered
  });

  it('correlation — 픽스처는 관심 미입력 버킷으로 수렴, 전환 학생의 등록 과목 조인', async () => {
    const correlation = (await http.get('/api/counsel/analytics/correlation').set(auth(admin)).expect(200)).body;
    expect(correlation.totalForms).toBe(3);
    const none = correlation.rows.find((row: { interestKey: string }) => row.interestKey === CORRELATION_NONE_KEY);
    expect(none).toMatchObject({ counselCount: 3, convertedCount: 1 }); // 학생2 전환
    expect(none.enrolledBySubject).toEqual([{ subject: '수학', count: 1 }]); // 학생2 → AP Calculus(수학)
  });

  it('기간 검증 400(형식·역전) · 역할 게이트(강사 403)', async () => {
    await http.get('/api/counsel/analytics/funnel?from=2026-7-1').set(auth(admin)).expect(400);
    await http.get('/api/counsel/analytics/funnel?from=2026-07-31&to=2026-07-01').set(auth(admin)).expect(400);
    await http.get('/api/counsel/analytics/funnel').set(auth(inst)).expect(403);
    await http.get('/api/counsel/analytics/correlation').set(auth(inst)).expect(403);
  });
});
