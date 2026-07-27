// [TBO-53 C1 2026-07-23] 결제·보고서 전이의 DB 권위 계약(메모리 상시 게이트) — TBO-50 P0-2/P0-3.
//  핵심 판정: ① 원장 금액 = CAS 반환 행(정정 후 수납 시 정정 금액) ② 전이 가드·멱등 ③ 승인 후 수정 400
//  ④ LOCK_KIND 네임스페이스 규약(payment:17·report:18 신설, 공유 예외는 payout·course 1쌍뿐 — C7에서 해소).
//  2-instance 경쟁의 실증은 money-race.e2e-spec(PG 전용)이 담당한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { LOCK_KIND } from '../src/database/calendar-unit-of-work.service';
import type { Transaction } from '../src/modules/transactions/transaction.entity';

describe('[TBO-53 C1] Money transitions — DB-authoritative CAS (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  const auth = (token: string) => sudoAuthHeaders(app, token);
  const ledgerOf = (paymentId: number) =>
    db.findAll<Transaction>('transactions').filter((tx) => tx.paymentId === paymentId);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('LOCK_KIND — payment:17·report:18 신설, 값 공유는 payout·course 1쌍만 허용(C7 해소 대기)', () => {
    expect(LOCK_KIND.payment).toBe(17);
    expect(LOCK_KIND.report).toBe(18);
    const values = Object.values(LOCK_KIND);
    // 유일성 규약: 허용된 예외(payout==course, TBO-50 P2 단계 전환 대기) 외 중복 0.
    expect(LOCK_KIND.payout).toBe(LOCK_KIND.course);
    expect(new Set(values).size).toBe(values.length - 1);
  });

  it('정정 → 수납: paid_amount·원장 금액이 정정된 DB 금액을 따른다(메모리 스냅샷 아님)', async () => {
    const created = (await http.post('/api/payments').set(auth(admin))
      .send({ studentId: 1, amount: 100000 }).expect(201)).body;
    await http.patch(`/api/payments/${created.id}`).set(auth(admin)).send({ amount: 130000 }).expect(200);
    const paid = (await http.post(`/api/payments/${created.id}/pay`).set(auth(admin)).expect(201)).body;
    expect(paid).toMatchObject({ status: 'paid', amount: 130000, paidAmount: 130000 });
    const ledger = ledgerOf(created.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'in', category: 'enrollment', amount: 130000 });
  });

  it('수납 멱등·환불 왕복: 재수납 400 · 환불 원장 1행(수납 금액과 동일) · 재환불 400', async () => {
    const created = (await http.post('/api/payments').set(auth(admin))
      .send({ studentId: 1, amount: 90000 }).expect(201)).body;
    await http.post(`/api/payments/${created.id}/pay`).set(auth(admin)).expect(201);
    await http.post(`/api/payments/${created.id}/pay`).set(auth(admin)).expect(400); // 이미 수납
    const refunded = (await http.post(`/api/payments/${created.id}/refund`).set(auth(admin)).expect(201)).body;
    expect(refunded.status).toBe('refunded');
    await http.post(`/api/payments/${created.id}/refund`).set(auth(admin)).expect(400); // 재환불 차단
    const ledger = ledgerOf(created.id);
    expect(ledger.map((tx) => tx.direction).sort()).toEqual(['in', 'out']);
    expect(ledger.find((tx) => tx.direction === 'out')?.amount).toBe(90000); // 환불 = 실수납 금액
  });

  it('완료 수납 정정 차단: paid 상태 금액 정정 400(원장 보존) · 메모 정정은 허용', async () => {
    const created = (await http.post('/api/payments').set(auth(admin))
      .send({ studentId: 2, amount: 70000 }).expect(201)).body;
    await http.post(`/api/payments/${created.id}/pay`).set(auth(admin)).expect(201);
    await http.patch(`/api/payments/${created.id}`).set(auth(admin)).send({ amount: 999 }).expect(400);
    await http.patch(`/api/payments/${created.id}`).set(auth(admin)).send({ memo: 'C1 메모 정정' }).expect(200);
  });

  it('청구 생성 관계 검증(DB 기준): 없는 학생 400 · 타인 수강 400 · 미연결 보호자 400', async () => {
    await http.post('/api/payments').set(auth(admin)).send({ studentId: 999999, amount: 1000 }).expect(400);
    // enrollment 1은 학생 1의 수강(픽스처) — 학생 2로 청구 시 불일치 400
    const anyEnrollment = db.findAll<{ id: number; studentId: number }>('enrollments')[0];
    const otherStudent = anyEnrollment.studentId === 1 ? 2 : 1;
    await http.post('/api/payments').set(auth(admin))
      .send({ studentId: otherStudent, enrollmentId: anyEnrollment.id, amount: 1000 }).expect(400);
    await http.post('/api/payments').set(auth(admin))
      .send({ studentId: 1, payerParentId: 999999, amount: 1000 }).expect(400);
  });

  it('보고서 전이 왕복: 승인 → 재승인 400 → 수정 400 → 반려(정산 미연결) → 재제출 가능', async () => {
    // 픽스처: report 1 = session 20 · student 1 · submitted, 세션 payout 미연결.
    const approved = (await http.post('/api/reports/1/approve').set(auth(admin)).expect(201)).body;
    expect(approved.approvalStatus).toBe('approved');
    await http.post('/api/reports/1/approve').set(auth(admin)).expect(400); // submitted만 승인 가능
    await http.patch('/api/reports/1').set(auth(admin)).send({ content: '변조 시도' }).expect(400); // 승인 후 수정 차단
    const rejected = (await http.post('/api/reports/1/reject').set(auth(admin))
      .send({ reason: 'C1 반려 검증' }).expect(201)).body;
    expect(rejected).toMatchObject({ approvalStatus: 'rejected', rejectedReason: 'C1 반려 검증' });
    const resubmitted = (await http.post('/api/reports/1/submit').set(auth(admin)).expect(201)).body;
    expect(resubmitted.approvalStatus).toBe('submitted');
    // audit 전이 사슬 — 같은 before 상태를 주장하는 모순 이력 0(approve/reject 각각 1회).
    const audits = db.findAll<{ entity: string; entityId: number; action: string }>('audit_log')
      .filter((row) => row.entity === 'session_reports' && row.entityId === 1 && ['approve', 'reject'].includes(row.action));
    expect(audits.map((row) => row.action).sort()).toEqual(['approve', 'reject']);
  });
});
