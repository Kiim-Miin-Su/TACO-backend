import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// ─────────────────────────────────────────────────────────────
// [자산화 2차 스위프 2026-07-03 — 실DB 이관 가정 감사 반영]
//  클라이언트(zustand/localStorage)에만 있던 업무 데이터의 DB 이관 + 원장 완결성(환불) 검증.
//  · calendar_view_presets: 캘린더 뷰 프리셋(TBO-12 P1) — 저장·중복 거부·삭제
//  · report_templates: 리포트 템플릿(시드 2건 = 기존 zustand 기본값 이관)
//  · expenses.rejectedReason: 반려 사유 서버 저장(이전 zustand 휘발)
//  · payments.refund: 수납의 역방향 출금 원장 기록 + 멱등(감사 발견 재무 공백)
// ─────────────────────────────────────────────────────────────
describe('Assetization sweep 2 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('view-presets: 저장·목록·이름 중복 400·삭제 (+비로그인 401)', async () => {
    const body = {
      name: '미국 학생 주간', view: 'week', instructorIds: [], studentIds: [1], roomIds: [],
      subjects: [], statuses: [], groupOnly: false, countryCode: 'US',
    };
    await http.get('/api/view-presets').expect(401); // 직원 자산 — 로그인 필수
    const created = (await http.post('/api/view-presets').set(asAdmin()).send(body).expect(201)).body;
    expect(created.countryCode).toBe('US');
    await http.post('/api/view-presets').set(asAdmin()).send(body).expect(400); // 이름 중복(실DB unique 정합)
    await http.post('/api/view-presets').set(asAdmin()).send({ ...body, name: 'x', countryCode: 'usa' }).expect(400); // 코드 형식
    const list = (await http.get('/api/view-presets').set(asAdmin()).expect(200)).body;
    expect(list.some((p: { id: number }) => p.id === created.id)).toBe(true);
    await http.delete(`/api/view-presets/${created.id}`).set(asAdmin()).expect(200);
    expect((await http.get('/api/view-presets').set(asAdmin()).expect(200)).body
      .some((p: { id: number }) => p.id === created.id)).toBe(false);
  });

  it('report-templates: 시드 2건(zustand 기본값 이관) + 생성·중복 400·삭제', async () => {
    const seeded = (await http.get('/api/report-templates').set(asAdmin()).expect(200)).body;
    expect(seeded.length).toBeGreaterThanOrEqual(2);
    expect(seeded.some((t: { name: string }) => t.name === '정규 수업(기본)')).toBe(true);
    const created = (await http.post('/api/report-templates').set(asAdmin())
      .send({ name: '레벨테스트', content: '레벨: \n권장 코스: ' }).expect(201)).body;
    await http.post('/api/report-templates').set(asAdmin())
      .send({ name: '레벨테스트', content: 'x' }).expect(400);
    await http.delete(`/api/report-templates/${created.id}`).set(asAdmin()).expect(200);
  });

  it('students PATCH: 국가·거주·상태 부분 수정(출국/입국·그만둠 대응) + 형식 가드 400', async () => {
    const st = (await http.post('/api/students').set(asAdmin())
      .send({ name: '수정테스트', country: 'KR' }).expect(201)).body;
    // 출국: KR→US + 해외 전환
    const moved = (await http.patch(`/api/students/${st.id}`).set(asAdmin())
      .send({ country: 'US', residenceType: 'overseas' }).expect(200)).body;
    expect(moved).toMatchObject({ country: 'US', residenceType: 'overseas', name: '수정테스트' });
    // 갑작스런 휴원
    expect((await http.patch(`/api/students/${st.id}`).set(asAdmin())
      .send({ status: 'paused' }).expect(200)).body.status).toBe('paused');
    // 가드: 잘못된 국가 코드·학년 범위·미존재 학생
    await http.patch(`/api/students/${st.id}`).set(asAdmin()).send({ country: 'usa' }).expect(400);
    await http.patch(`/api/students/${st.id}`).set(asAdmin()).send({ grade: 13 }).expect(400);
    await http.patch('/api/students/99999').set(asAdmin()).send({ status: 'active' }).expect(404);
  });

  it('expenses.reject: 반려 사유가 서버에 저장된다(클라 휘발 → 자산)', async () => {
    const exp = (await http.post('/api/expenses').set(asAdmin())
      .send({ title: '반려사유 테스트', amount: 1000, category: 'supplies', spentAt: '2099-06-01' }).expect(201)).body;
    await http.post(`/api/expenses/${exp.id}/reject`).set(asAdmin())
      .send({ reason: '증빙 누락 — 영수증 재첨부 요망' }).expect(201);
    const saved = (await http.get('/api/expenses').set(asAdmin()).expect(200)).body
      .find((x: { id: number }) => x.id === exp.id);
    expect(saved.status).toBe('rejected');
    expect(saved.rejectedReason).toBe('증빙 누락 — 영수증 재첨부 요망');
  });

  it('payments.refund: paid→refunded + 원장 출금(역참조) + 멱등·미수납 400', async () => {
    const listLen = async () => ((await http.get('/api/transactions').set(asAdmin()).expect(200)).body as unknown[]).length;
    const pay = (await http.post('/api/payments').set(asAdmin())
      .send({ studentId: 1, courseId: 10, amount: 220000, dueAt: '2099-06-02' }).expect(201)).body;
    await http.post(`/api/payments/${pay.id}/refund`).set(asAdmin()).expect(400); // 미수납 환불 금지
    await http.post(`/api/payments/${pay.id}/pay`).set(asAdmin()).send({ method: 'card' }).expect(201);
    const txBefore = await listLen();
    const refunded = (await http.post(`/api/payments/${pay.id}/refund`).set(asAdmin()).expect(201)).body;
    expect(refunded.status).toBe('refunded');
    const txs = (await http.get('/api/transactions').set(asAdmin()).expect(200)).body;
    expect(txs.length).toBe(txBefore + 1);
    const refundTx = txs.find((t: { paymentId?: number; direction: string; category: string }) =>
      t.paymentId === pay.id && t.direction === 'out' && t.category === 'refund');
    expect(refundTx?.amount).toBe(220000);
    // 멱등: 재환불 400 + 원장 불변(이중 출금 방지)
    await http.post(`/api/payments/${pay.id}/refund`).set(asAdmin()).expect(400);
    expect(await listLen()).toBe(txBefore + 1);
  });
});
