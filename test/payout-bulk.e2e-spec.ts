// [TBO-32 C1 2026-07-20] 일괄 산정·미정산 감지·세션 지급 플래그(is_paid) e2e. 검증:
//  ① uncovered — 적격 세션이 남은 (강사×월)만 노출(연결·미적격 제외), 대표 전용
//  ② 진행된 수업만 — scheduled/canceled는 만들어도 산정에 안 잡힘(대표 지시 재확인)
//  ③ generate-bulk — 강사별 독립: park 생성 + jung skipped(전량 연결), 재실행 시 이중 계상 0
//  ④ is_paid 수명주기 — pay 시 전 세션 true+paid_payout_id, reverse 시 false 복귀(paid_payout_id
//    는 이력 유지) → 같은 기간 재산정 금액 동일
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

type SessionRow = {
  id: number; status: string; payoutId?: number | null; isPaid?: boolean; paidPayoutId?: number | null;
};

describe('Payout bulk + uncovered + is_paid (e2e, TBO-32 C1)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let inst = '';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const JUNE = { periodStart: '2026-06-01', periodEnd: '2026-06-30' };
  const sessionOf = (id: number) => db.findById<SessionRow>('class_sessions', id)!;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('① uncovered: park 6월(적격 3)만 노출 — jung(전량 연결)은 없음 · 강사 403 · months 범위 방어', async () => {
    const entries = (await http.get('/api/payouts/uncovered?months=3').set(auth(admin)).expect(200)).body as Array<{
      instructorId: number; month: string; sessionCount: number; computedAmount: number;
    }>;
    const park = entries.find((e) => e.instructorId === 1 && e.month === '2026-06');
    expect(park).toBeDefined();
    expect(park!.sessionCount).toBe(3); // 시드: held+승인 보고서 3건(무보고 held·canceled 제외)
    expect(park!.computedAmount).toBeGreaterThan(0);
    // [TBO-66 T2] uncovered에 '실행 미확정' 엔트리가 추가됨 — jung의 **6월** 부재만 단언(현재 주
    //  scheduled 경과분은 executionMissingCount 엔트리로 정당하게 노출된다).
    expect(entries.some((e) => e.instructorId === 2 && e.month === '2026-06')).toBe(false); // jung 6월은 시드에서 지급 완료(전량 연결)
    for (const e of entries.filter((x) => x.month !== '2026-06')) {
      expect((e as { executionMissingCount: number }).executionMissingCount + e.sessionCount).toBeGreaterThan(0); // 노출 근거 명시
    }
    await http.get('/api/payouts/uncovered').set(auth(inst)).expect(403); // 돈 정보 — 대표 전용
    await http.get('/api/payouts/uncovered?months=99').set(auth(admin)).expect(200); // 1~12로 clamp(500 아님)
  });

  it('② 진행된 수업만: scheduled·canceled 세션을 추가해도 산정(preview·uncovered)에 잡히지 않는다', async () => {
    const before = (await http.get('/api/payouts/preview?instructorId=1&from=2026-06-01&to=2026-06-30')
      .set(auth(admin)).expect(200)).body;
    expect(before.sessionCount).toBe(3);

    // 예정(scheduled — 기본값)·취소(canceled) 세션 추가 — 진행 완료가 아니므로 시수 제외여야 한다.
    await http.post('/api/schedule').set(auth(admin))
      .send({ courseId: 10, instructorId: 1, sessionDate: '2026-06-22', startTime: '10:00', durationMinutes: 90 })
      .expect(201);
    await http.post('/api/schedule').set(auth(admin))
      .send({ courseId: 10, instructorId: 1, sessionDate: '2026-06-23', startTime: '10:00', durationMinutes: 90, status: 'canceled' })
      .expect(201);

    const after = (await http.get('/api/payouts/preview?instructorId=1&from=2026-06-01&to=2026-06-30')
      .set(auth(admin)).expect(200)).body;
    expect(after.sessionCount).toBe(3); // 변동 0 — held만 시수 포함
    expect(after.computedAmount).toBe(before.computedAmount);
  });

  it('③ generate-bulk: park 생성·jung skipped(강사별 독립) → 재실행 이중 계상 0 → uncovered 6월 소거', async () => {
    const run1 = (await http.post('/api/payouts/generate-bulk').set(auth(admin)).send(JUNE).expect(201)).body;
    expect(run1.generated).toHaveLength(1);
    expect(run1.generated[0]).toMatchObject({ instructorId: 1, sessionCount: 3 });
    expect(run1.skipped).toEqual(expect.arrayContaining([{ instructorId: 2, reason: 'no_eligible_sessions' }]));
    expect(run1.failed).toHaveLength(0);

    // 재실행 — 이미 전량 연결이라 신규 정산 0(이중 계상 방지 그대로)
    const run2 = (await http.post('/api/payouts/generate-bulk').set(auth(admin)).send(JUNE).expect(201)).body;
    expect(run2.generated).toHaveLength(0);
    expect(run2.skipped.map((s: { instructorId: number }) => s.instructorId).sort()).toEqual([1, 2]);

    const entries = (await http.get('/api/payouts/uncovered?months=3').set(auth(admin)).expect(200)).body as Array<{ month: string; instructorId: number; sessionCount: number }>;
    // [TBO-66 T2] 적격 소거만 단언 — ②가 추가한 6월 scheduled는 실행 미확정 엔트리(sessionCount 0)로 남는 것이 신계약
    expect(entries.some((e) => e.month === '2026-06' && e.sessionCount > 0)).toBe(false); // 6월 미정산(적격) 소거

    await http.post('/api/payouts/generate-bulk').set(auth(inst)).send(JUNE).expect(403); // 대표 전용
    await http.post('/api/payouts/generate-bulk').set(auth(admin))
      .send({ periodStart: '2026-06-01', periodEnd: '06-30' }).expect(400); // DTO 날짜 형식
  });

  it('④ is_paid 수명주기: pay=전 세션 true+스탬프 → reverse=false 복귀(이력 유지) → 재산정 금액 동일', async () => {
    const payout = (await http.get('/api/payouts').set(auth(admin)).expect(200)).body
      .find((p: { instructorId: number; status: string }) => p.instructorId === 1 && p.status === 'pending');
    expect(payout).toBeDefined();
    const lineSessionIds: number[] = payout.lines.map((l: { sessionId: number }) => l.sessionId);

    // 지급 전에는 연결만 — is_paid=false
    for (const id of lineSessionIds) expect(sessionOf(id).isPaid ?? false).toBe(false);

    await http.post(`/api/payouts/${payout.id}/confirm`).set(auth(admin)).expect(201);
    await http.post(`/api/payouts/${payout.id}/pay`).set(auth(admin)).expect(201);
    for (const id of lineSessionIds) {
      expect(sessionOf(id)).toMatchObject({ payoutId: payout.id, isPaid: true, paidPayoutId: payout.id });
    }

    // 회수 — is_paid=false 복귀 + payoutId 해제, paid_payout_id는 이력으로 잔존
    await http.post(`/api/payouts/${payout.id}/reverse`).set(auth(admin))
      .send({ reason: '지급 착오 — 재산정 필요' }).expect(201);
    for (const id of lineSessionIds) {
      const row = sessionOf(id);
      expect(row.isPaid).toBe(false);
      expect(row.payoutId ?? null).toBeNull();
      expect(row.paidPayoutId).toBe(payout.id); // 회수 이력 판별(is_paid=false ∧ paid_payout_id≠NULL)
    }

    // 같은 기간 재산정(일괄) — 회수분이 다시 적격, 금액 동일(사이클 무결성)
    const rerun = (await http.post('/api/payouts/generate-bulk').set(auth(admin)).send(JUNE).expect(201)).body;
    expect(rerun.generated).toHaveLength(1);
    expect(rerun.generated[0].amount).toBe(payout.amount);
    expect(rerun.generated[0].sessionCount).toBe(payout.sessionCount);
  });

  it('④b 시드 지급분(jung) backfill 정합: paid 정산서의 세션은 is_paid=true+스탬프', async () => {
    const paid = (await http.get('/api/payouts').set(auth(admin)).expect(200)).body
      .find((p: { instructorId: number; status: string }) => p.instructorId === 2 && p.status === 'paid');
    expect(paid).toBeDefined();
    for (const l of paid.lines as Array<{ sessionId: number }>) {
      expect(sessionOf(l.sessionId)).toMatchObject({ payoutId: paid.id, isPaid: true, paidPayoutId: paid.id });
    }
  });
});
