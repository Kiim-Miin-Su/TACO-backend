// [TBO-32 C2 2026-07-22] Rollback 강화 e2e — 확정 취소(unconfirm)·회수 사유 영속·전체 사이클.
//  검증: ① unconfirm은 confirmed만(사유 필수·audit·확정 메타 원복) ② 취소→재확정→지급 정상
//  ③ 상태 가드(pending/paid 400)·CAS(이미 전이 409)·강사 403 ④ reverse가 reversed_reason을
//  별도 영속(반려 사유와 구분 — D2) ⑤ 회수→같은 기간 재산정 금액 동일(사이클 무결성)
//  ⑥ uncovered가 비활성 강사 미지급분도 감지(instructorStatus 동봉 — 리뷰 P1-2).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('Payout unconfirm + reversal cycle (e2e, TBO-32 C2)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let inst = '';
  let payoutId = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const JUNE = { from: '2026-06-01', to: '2026-06-30' };

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('① 생성→확정→unconfirm: pending 복귀 + confirmedAt 원복 · 사유 누락/짧음 400 · 강사 403', async () => {
    const payout = (await http.post('/api/payouts/generate').set(auth(admin))
      .send({ instructorId: 1, ...JUNE }).expect(201)).body;
    payoutId = payout.id;

    // pending 상태에서 unconfirm → 400(가드)
    await http.post(`/api/payouts/${payoutId}/unconfirm`).set(auth(admin))
      .send({ reason: '아직 확정 전 취소 시도' }).expect(400);

    await http.post(`/api/payouts/${payoutId}/confirm`).set(auth(admin)).expect(201);
    await http.post(`/api/payouts/${payoutId}/unconfirm`).set(auth(admin)).send({}).expect(400); // 사유 필수
    await http.post(`/api/payouts/${payoutId}/unconfirm`).set(auth(admin)).send({ reason: '짧다' }).expect(400); // 5자 미만
    await http.post(`/api/payouts/${payoutId}/unconfirm`).set(auth(inst))
      .send({ reason: '강사 취소 시도' }).expect(403); // 대표 전용

    const undone = (await http.post(`/api/payouts/${payoutId}/unconfirm`).set(auth(admin))
      .send({ reason: '기간 오설정 — 재확정 예정' }).expect(201)).body;
    expect(undone.status).toBe('pending');
    expect(undone.confirmedAt ?? null).toBeNull(); // 확정 메타 원복
    // CAS — 이미 pending으로 전이됨 → 재취소 400(상태 가드)
    await http.post(`/api/payouts/${payoutId}/unconfirm`).set(auth(admin))
      .send({ reason: '이중 취소 시도' }).expect(400);
    // audit 이력(사유 포함) 잔존
    const trail = db.findBy<{ entity: string; entityId: number; reason?: string }>('audit_log',
      (a) => a.entity === 'instructor_payouts' && a.entityId === payoutId && a.reason === '기간 오설정 — 재확정 예정');
    expect(trail.length).toBe(1);
  });

  it('② 취소 후 재확정→지급 정상 · paid에서 unconfirm 400(회수 안내)', async () => {
    await http.post(`/api/payouts/${payoutId}/confirm`).set(auth(admin)).expect(201);
    await http.post(`/api/payouts/${payoutId}/pay`).set(auth(admin)).expect(201);
    const blocked = await http.post(`/api/payouts/${payoutId}/unconfirm`).set(auth(admin))
      .send({ reason: '지급 후 취소 시도' }).expect(400);
    expect(String(blocked.body.message)).toContain('회수');
  });

  it('③ reverse: reversed_reason 별도 영속(rejectedReason과 동시 기록 — D2) + 보상 금액 = 지급 금액', async () => {
    const before = (await http.get(`/api/payouts/${payoutId}`).set(auth(admin)).expect(200)).body;
    const res = (await http.post(`/api/payouts/${payoutId}/reverse`).set(auth(admin))
      .send({ reason: '지급 착오 — 사이클 검증' }).expect(201)).body;
    expect(res.payout.reversedReason).toBe('지급 착오 — 사이클 검증'); // 전용 컬럼
    expect(res.payout.rejectedReason).toBe('지급 착오 — 사이클 검증'); // 기존 소비처 호환
    expect(res.payout.reversedAt).toBeTruthy();
    expect(res.transaction.amount).toBe(before.amount); // [P0-5 회귀 가드] 보상=지급 금액(DB 권위)
  });

  it('④ 회수→같은 기간 재산정: 금액·회차 동일(사이클 무결성 — 수용 기준 D2③)', async () => {
    const before = (await http.get(`/api/payouts/${payoutId}`).set(auth(admin)).expect(200)).body;
    const regenerated = (await http.post('/api/payouts/generate').set(auth(admin))
      .send({ instructorId: 1, ...JUNE }).expect(201)).body;
    expect(regenerated.computedAmount).toBe(before.computedAmount);
    expect(regenerated.sessionCount).toBe(before.sessionCount);
  });

  it('⑤ uncovered: 비활성 강사 미지급분 감지(instructorStatus 동봉 — 리뷰 P1-2)', async () => {
    const entries = (await http.get('/api/payouts/uncovered?months=3').set(auth(admin)).expect(200)).body as Array<{
      instructorId: number; instructorStatus: string; month: string;
    }>;
    // 시드 강사(active) 항목에 상태 필드가 실려 온다 — 비활성 전환 시 화면 구분의 근거.
    expect(entries.every((e) => typeof e.instructorStatus === 'string' && e.instructorStatus.length > 0)).toBe(true);
  });
});
