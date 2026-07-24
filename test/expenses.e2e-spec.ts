// [TBO-58 P2 2026-07-24] 지출 홈 스위트 — 종전엔 분산 커버(승인 흐름만)라 404·반려 사유·권한이
//  미검증이었다(검증③ 실측). + 이번에 신설한 수정(PATCH)·철회(DELETE)의 상태 가드/원장 정합까지
//  응집 검증. 지출은 super_admin 전용(TBO-21 RBAC — manager도 403).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('[TBO-58] expenses 홈 스위트 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  const newExpense = (title: string, amount = 50_000) => ({
    category: 'supplies', title, amount, spentAt: '2026-07-24', vendor: 'QA상사',
  });

  it('권한 — 지출 전 경로는 super_admin 전용(manager·강사 403)', async () => {
    for (const who of ['manager', 'park_inst']) {
      await http.get('/api/expenses').set(auth(who)).expect(403);
      await http.post('/api/expenses').set(auth(who)).send(newExpense('권한 검증')).expect(403);
      await http.patch('/api/expenses/1').set(auth(who)).send({ amount: 1 }).expect(403);
      await http.delete('/api/expenses/1').set(auth(who)).expect(403);
    }
    await http.get('/api/expenses').expect(401); // 비로그인
  });

  it('404 경로 — 없는 지출 approve/reject/patch/delete', async () => {
    await http.post('/api/expenses/999999/approve').set(auth('admin')).expect(404);
    await http.post('/api/expenses/999999/reject').set(auth('admin')).send({ reason: '없음' }).expect(404);
    await http.patch('/api/expenses/999999').set(auth('admin')).send({ amount: 1 }).expect(404);
    await http.delete('/api/expenses/999999').set(auth('admin')).expect(404);
  });

  it('반려 사유 검증 — reason 누락/공백 400(사유 필수 규약 Q2)', async () => {
    const row = (await http.post('/api/expenses').set(auth('admin')).send(newExpense('반려 사유 검증')).expect(201)).body;
    await http.post(`/api/expenses/${row.id}/reject`).set(auth('admin')).send({}).expect(400);
    await http.post(`/api/expenses/${row.id}/reject`).set(auth('admin')).send({ reason: '' }).expect(400);
    const rejected = (await http.post(`/api/expenses/${row.id}/reject`).set(auth('admin')).send({ reason: '증빙 누락' }).expect(201)).body;
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectedReason).toBe('증빙 누락');
    // rejected는 수정·철회 불가(이력 보존) — 새 요청으로 다시
    await http.patch(`/api/expenses/${row.id}`).set(auth('admin')).send({ amount: 1 }).expect(400);
    await http.delete(`/api/expenses/${row.id}`).set(auth('admin')).expect(400);
  });

  it('수정(PATCH) — requested만, 필드 정정 후 승인하면 정정된 금액으로 원장 기록', async () => {
    const row = (await http.post('/api/expenses').set(auth('admin')).send(newExpense('오기입 정정', 90_000)).expect(201)).body;
    // 빈 patch 400
    await http.patch(`/api/expenses/${row.id}`).set(auth('admin')).send({}).expect(400);
    // 검증 위반 400 (음수 금액)
    await http.patch(`/api/expenses/${row.id}`).set(auth('admin')).send({ amount: -1 }).expect(400);
    // 정정 성공
    const patched = (await http.patch(`/api/expenses/${row.id}`).set(auth('admin')).send({ amount: 30_000, title: '오기입 정정(확정)' }).expect(200)).body;
    expect(patched.amount).toBe(30_000);
    expect(patched.title).toBe('오기입 정정(확정)');
    expect(patched.status).toBe('requested'); // 상태는 불변(전용 명령만)
    // 승인 → 원장 출금 1줄이 **정정된 금액**으로
    await http.post(`/api/expenses/${row.id}/approve`).set(auth('admin')).expect(201);
    const ledger = (await http.get('/api/transactions').set(auth('admin')).expect(200)).body as Array<{ expenseId?: number; amount: number; direction: string }>;
    const tx = ledger.find((t) => t.expenseId === row.id);
    expect(tx).toBeDefined();
    expect(tx!.amount).toBe(30_000);
    expect(tx!.direction).toBe('out');
    // 승인 후엔 불변(원장 정합) — 수정·철회 400
    await http.patch(`/api/expenses/${row.id}`).set(auth('admin')).send({ amount: 1 }).expect(400);
    await http.delete(`/api/expenses/${row.id}`).set(auth('admin')).expect(400);
  });

  it('철회(DELETE) — requested만 soft delete, 목록·단건에서 사라진다', async () => {
    const row = (await http.post('/api/expenses').set(auth('admin')).send(newExpense('철회 대상')).expect(201)).body;
    const res = (await http.delete(`/api/expenses/${row.id}`).set(auth('admin')).expect(200)).body;
    expect(res).toEqual({ id: row.id, deleted: true });
    await http.get(`/api/expenses/${row.id}`).set(auth('admin')).expect(404); // 단건 404
    const list = (await http.get('/api/expenses').set(auth('admin')).expect(200)).body as Array<{ id: number }>;
    expect(list.some((e) => e.id === row.id)).toBe(false); // 목록 제외(soft delete)
    // 철회된 지출은 원장에 아무 기록도 남기지 않는다
    const ledger = (await http.get('/api/transactions').set(auth('admin')).expect(200)).body as Array<{ expenseId?: number }>;
    expect(ledger.some((t) => t.expenseId === row.id)).toBe(false);
  });

  it('X-Request-Id — 응답 헤더 반환 + 클라이언트 rid 채택(로그 상관관계 배관)', async () => {
    const res = await http.get('/api/expenses').set(auth('admin')).expect(200);
    expect(String(res.headers['x-request-id'] ?? '')).toMatch(/^[A-Za-z0-9._-]{4,64}$/);
    const echoed = await http.get('/api/expenses').set(auth('admin')).set('X-Request-Id', 'qa-rid-1234').expect(200);
    expect(echoed.headers['x-request-id']).toBe('qa-rid-1234');
    const tooLong = await http.get('/api/expenses').set(auth('admin')).set('X-Request-Id', 'x'.repeat(80)).expect(200);
    expect(tooLong.headers['x-request-id']).not.toContain('xxxxxxxx'); // 형식 위반(64자 초과)은 서버 발급으로 대체
    const tooShort = await http.get('/api/expenses').set(auth('admin')).set('X-Request-Id', 'ab').expect(200);
    expect(tooShort.headers['x-request-id']).not.toBe('ab'); // 4자 미만도 서버 발급
  });
});
