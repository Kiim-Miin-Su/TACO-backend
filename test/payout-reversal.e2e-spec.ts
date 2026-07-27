// [B9 E5 2026-07-16] 지급 회수(payout reversal) — FEATURE-GAP P1. 검증:
//  ① paid만 회수 가능(전 상태 400) ② 회수 = rejected+reversedAt + 보상 원장 입금 1건(금액 대사)
//    + 세션 연결 전량 해제 + 감사 이력 — 한 tx ③ 회수가 실제로 여는 흐름 2개:
//    수업 수정의 PAYOUT_REVERSAL_REQUIRED 409 해소, 승인 보고서 반려("정산 회수 후") 허용
//  ④ 회수 후 같은 기간 재산정(generate) 가능 ⑤ 재회수 400 · 강사 403.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('Payout reversal (e2e, B9 E5)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let inst = '';
  let payoutId = 0;
  let lineSessionIds: number[] = [];
  const auth = (t: string) => sudoAuthHeaders(app, t);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('생성→확정: 지급 전(confirmed)은 회수 400(반려 사용 안내) · 사유 누락 400', async () => {
    const payout = (await http.post('/api/payouts/generate').set(auth(admin))
      .send({ instructorId: 1, from: '2026-06-01', to: '2026-06-30' }).expect(201)).body;
    payoutId = payout.id;
    lineSessionIds = payout.lines.map((l: { sessionId: number }) => l.sessionId);
    expect(lineSessionIds.length).toBeGreaterThan(0);
    await http.post(`/api/payouts/${payoutId}/confirm`).set(auth(admin)).expect(201);

    const blocked = await http.post(`/api/payouts/${payoutId}/reverse`).set(auth(admin))
      .send({ reason: '지급 전 회수 시도' }).expect(400);
    expect(String(blocked.body.message)).toContain('반려');
    await http.post(`/api/payouts/${payoutId}/reverse`).set(auth(admin)).send({}).expect(400); // 사유 필수(DTO)
  });

  it('지급 후: 연결 세션 수정은 409 PAYOUT_REVERSAL_REQUIRED · 강사 회수 403', async () => {
    await http.post(`/api/payouts/${payoutId}/pay`).set(auth(admin)).expect(201);
    const locked = await http.patch(`/api/schedule/${lineSessionIds[0]}`).set(auth(admin))
      .send({ topic: 'B9 잠금 검증' }).expect(409);
    expect(locked.body.code).toBe('PAYOUT_REVERSAL_REQUIRED');
    await http.post(`/api/payouts/${payoutId}/reverse`).set(auth(inst)).send({ reason: '강사 시도' }).expect(403);
  });

  it('회수 성공: rejected+reversedAt · 보상 입금 1건(금액 대사) · 세션 전량 해제 · 감사 2건 · 재회수 400', async () => {
    const before = (await http.get(`/api/payouts/${payoutId}`).set(auth(admin)).expect(200)).body;
    const res = (await http.post(`/api/payouts/${payoutId}/reverse`).set(auth(admin))
      .send({ reason: '보고서 반려로 시수 재산정 필요' }).expect(201)).body;
    expect(res.payout.status).toBe('rejected');
    expect(res.payout.reversedAt).toBeTruthy();
    expect(res.payout.rejectedReason).toBe('보고서 반려로 시수 재산정 필요');
    expect(res.transaction.direction).toBe('in');
    expect(res.transaction.category).toBe('payout_reversal');
    expect(res.transaction.amount).toBe(before.amount); // 전액 보상 대사
    expect(res.transaction.payoutId).toBe(payoutId);

    // 세션 연결 전량 해제(재산정 가능 복귀)
    for (const sid of lineSessionIds) {
      const s = db.findById<{ payoutId?: number | null; instructorPayAmount?: number | null }>('class_sessions', sid);
      expect(s?.payoutId ?? null).toBeNull();
      expect(s?.instructorPayAmount ?? null).toBeNull();
    }
    // 원장: 출금(지급) 1건 + 입금(회수) 1건 — append-only(원 거래 불변)
    const txs = db.findAll<{ payoutId?: number; direction: string; category: string; amount: number }>('transactions')
      .filter((t) => t.payoutId === payoutId);
    expect(txs.filter((t) => t.direction === 'out' && t.category === 'instructor_payout')).toHaveLength(1);
    expect(txs.filter((t) => t.direction === 'in' && t.category === 'payout_reversal')).toHaveLength(1);
    // 감사: 회수 status_change(사유·releasedSessionIds) + 보상 거래 create
    const audits = db.findAll<{ entity: string; entityId: number; action: string; reason?: string; changes?: Record<string, { after?: unknown }> }>('audit_log');
    const reversal = audits.find((a) => a.entity === 'instructor_payouts' && a.entityId === payoutId && a.changes?.reversedAt);
    expect(reversal?.reason).toBe('보고서 반려로 시수 재산정 필요');
    expect(Array.isArray(reversal?.changes?.releasedSessionIds?.after)).toBe(true);
    expect(audits.some((a) => a.entity === 'transactions' && a.changes?.category?.after === 'payout_reversal')).toBe(true);

    const again = await http.post(`/api/payouts/${payoutId}/reverse`).set(auth(admin))
      .send({ reason: '재회수 시도' }).expect(400);
    expect(String(again.body.message)).toContain('회수 불가 상태');
  });

  it('회수가 여는 흐름: 세션 수정 200(409 해소) · 승인 보고서 반려 성공 · 같은 기간 재산정 201', async () => {
    // ① 종전 409였던 수정이 통과
    await http.patch(`/api/schedule/${lineSessionIds[0]}`).set(auth(admin))
      .send({ topic: 'B9 회수 후 수정' }).expect(200);
    // ② 승인 보고서 반려 — 종전 "정산 회수 후 처리 필요" 400이 열림
    const approved = db.findAll<{ id: number; sessionId: number; approvalStatus: string }>('session_reports')
      .find((r) => lineSessionIds.includes(r.sessionId) && r.approvalStatus === 'approved');
    expect(approved).toBeTruthy();
    const rejected = (await http.post(`/api/reports/${approved!.id}/reject`).set(auth(admin))
      .send({ reason: 'B9 회수 후 반려' }).expect(201)).body;
    expect(rejected.approvalStatus).toBe('rejected');
    // ③ 세션이 미정산으로 복귀했으므로 같은 기간 재산정 가능(반려된 보고서 세션은 적격에서 빠짐 — 잔여로 생성)
    const regenerated = (await http.post('/api/payouts/generate').set(auth(admin))
      .send({ instructorId: 1, from: '2026-06-01', to: '2026-06-30' }).expect(201)).body;
    expect(regenerated.id).not.toBe(payoutId);
    expect(regenerated.lines.length).toBeGreaterThan(0);
  });
});
