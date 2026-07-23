// [TBO-46 G1 2026-07-23] GraphQL 게이트웨이 검증 — ① revenue-analytics 순수 함수 결정적 수치
//  ② API 배선: 픽스처 수치 고정·REST와 동일값(단일 진실원 증명)·역할 403·검증 400·깊이 400·
//  production introspection 거부·Mutation 부재.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { computeFinanceSummary, computeRevenueReport, type RevenueSnapshot } from '../src/modules/graphql/revenue-analytics';

const snapshot = (): RevenueSnapshot => ({
  payments: [
    { studentId: 1, enrollmentId: 1, amount: 100000, paidAmount: 90000, status: 'paid', paidAt: '2026-07-05' }, // 부분 납부 — 실현 90k
    { studentId: 2, enrollmentId: 2, amount: 200000, paidAmount: null, status: 'paid', paidAt: '2026-07-20' },  // paidAmount 없음 — amount
    { studentId: 1, enrollmentId: null, amount: 50000, paidAmount: 50000, status: 'paid', paidAt: '2026-07-10' }, // 수강 미연결 — 기타 버킷
    { studentId: 2, enrollmentId: 2, amount: 300000, status: 'pending' },                                        // 미납
    { studentId: 1, enrollmentId: 1, amount: 150000, paidAmount: 150000, status: 'paid', paidAt: '2026-06-01' }, // 기간 밖
  ],
  enrollments: [{ id: 1, courseId: 10 }, { id: 2, courseId: 11 }],
  courses: [{ id: 10, name: 'SAT', subjectId: 1 }, { id: 11, name: 'AP', subjectId: 2 }],
  subjects: [{ id: 1, name: '영어' }, { id: 2, name: '수학' }],
  students: [{ id: 1, name: '김a' }, { id: 2, name: '이b' }],
  expenses: [
    { amount: 40000, status: 'approved', spentAt: '2026-07-03' },
    { amount: 999999, status: 'requested', spentAt: '2026-07-04' }, // 미승인 제외
    { amount: 10000, status: 'approved', spentAt: '2026-06-01' },   // 기간 밖
  ],
  payouts: [
    { amount: 70000, status: 'paid', paidAt: '2026-07-15' },
    { amount: 999999, status: 'confirmed', paidAt: null }, // 미지급 제외
  ],
});
const JULY = { from: '2026-07-01', to: '2026-07-31' };

describe('revenue-analytics 순수 함수 (TBO-46 G1)', () => {
  it('실현 매출 = paidAmount ?? amount · 기간 필터 · 미납 · 버킷(월/과목/코스/학생/기타)', () => {
    const report = computeRevenueReport(snapshot(), JULY);
    expect(report.realizedTotal).toBe(90000 + 200000 + 50000); // 340k — 기간 밖 150k 제외
    expect(report.unpaidTotal).toBe(300000);
    expect(report.unpaidCount).toBe(1);
    expect(report.byMonth).toEqual([{ key: '2026-07', amount: 340000, count: 3 }]);
    const bySubject = Object.fromEntries(report.bySubject.map((row) => [row.key, row.amount]));
    expect(bySubject).toEqual({ '수학': 200000, '영어': 90000, '기타(수강 미연결)': 50000 });
    const byStudent = Object.fromEntries(report.byStudent.map((row) => [row.key, row.amount]));
    expect(byStudent).toEqual({ '이b': 200000, '김a': 140000 });
  });

  it('financeSummary — 순이익 = 매출 − 승인 지출 − 지급 정산(기간·상태 필터)', () => {
    const summary = computeFinanceSummary(snapshot(), JULY);
    expect(summary).toMatchObject({ revenue: 340000, expenses: 40000, payouts: 70000, net: 230000 });
  });
});

describe('POST /graphql (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin = '';
  let inst = '';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const gql = (query: string, token = admin) => http.post('/api/graphql').set(auth(token)).send({ query });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('revenueReport — 픽스처 수치 고정(6월 실현 3건 148만·미납 2건 90만)', async () => {
    const res = await gql(`{ revenueReport(from: "2026-06-01", to: "2026-06-30") {
      realizedTotal unpaidTotal unpaidCount byMonth { key amount count } bySubject { key amount } } }`).expect(201);
    const report = res.body.data.revenueReport;
    expect(report.realizedTotal).toBe(480000 + 520000 + 480000); // 6월 paid 3건
    expect(report.unpaidTotal).toBe(480000 + 420000);
    expect(report.unpaidCount).toBe(2);
    expect(report.byMonth).toEqual([{ key: '2026-06', amount: 1480000, count: 3 }]);
  });

  it('financeSummary — 매출−지출−정산 순이익(6월)', async () => {
    const res = await gql(`{ financeSummary(from: "2026-06-01", to: "2026-06-30") { revenue expenses payouts net } }`).expect(201);
    const summary = res.body.data.financeSummary;
    expect(summary.revenue).toBe(1480000);
    expect(summary.expenses).toBe(86000 + 450000 + 680000 + 240000); // 승인분만
    expect(summary.net).toBe(summary.revenue - summary.expenses - summary.payouts);
  });

  it('counselFunnel — REST 분석 API와 동일값(같은 서비스 경로 = 단일 진실원 증명)', async () => {
    const rest = (await http.get('/api/counsel/analytics/funnel').set(auth(admin)).expect(200)).body;
    const res = await gql(`{ counselFunnel { total conversionRate dropRate avgRoundsToConversion
      statusCounts { key count } roundReach { rounds count } } }`).expect(201);
    const funnel = res.body.data.counselFunnel;
    expect(funnel.total).toBe(rest.total);
    expect(funnel.conversionRate).toBeCloseTo(rest.conversionRate);
    expect(funnel.avgRoundsToConversion).toBe(rest.avgRoundsToConversion);
    const registered = funnel.statusCounts.find((row: { key: string }) => row.key === 'registered');
    expect(registered.count).toBe(rest.statusCounts.registered);
  });

  it('uncoveredPayouts — REST 미정산 감지와 동일 소스', async () => {
    const rest = (await http.get('/api/payouts/uncovered').set(auth(admin)).expect(200)).body;
    const res = await gql(`{ uncoveredPayouts { instructorId instructorName month sessionCount computedAmount } }`).expect(201);
    expect(res.body.data.uncoveredPayouts.length).toBe(rest.length);
  });

  it('경계 — 강사 403 · 잘못된 기간 400 · 미정의 필드 400 · 깊이 초과 400 · Mutation 부재', async () => {
    await gql('{ revenueReport { realizedTotal } }', inst).expect(403);
    await gql('{ revenueReport(from: "2026-7-1") { realizedTotal } }').expect(400); // 형식 — REST와 같은 규칙
    await gql('{ nosuchfield }').expect(400); // 스키마 검증
    await gql('mutation { anything }').expect(400); // Mutation 타입 자체가 없음
    // 깊이 초과(7중첩 — 인라인 프래그먼트로 강제)
    const deep = '{ revenueReport { byMonth { ... on KeyAmount { ... on KeyAmount { ... on KeyAmount { ... on KeyAmount { ... on KeyAmount { key } } } } } } } }';
    await gql(deep).expect(400);
  });

  it('production introspection 거부(요청 시점 판정) · 개발은 허용', async () => {
    const query = '{ __schema { queryType { name } } }';
    await gql(query).expect(201); // 개발·테스트 허용
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await gql(query);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('검증 실패');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
