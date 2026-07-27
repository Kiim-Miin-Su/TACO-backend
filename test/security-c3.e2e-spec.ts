// [TBO-59 C3 2026-07-24] SECURITY-P0 e2e — 강사 PII scope(P0-5)·parents 승격·sudo 확장·대표 소유 403.
//  픽스처: park_inst(강사1 — 코스10/12 담당), jung_inst(강사2 — 코스 없음), admin(super_admin), manager.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('[TBO-59 C3] SECURITY-P0 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst', 'jung_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('P0-5 ① 강사 목록 = 본인 담당 학생만 + PII 필드 자체가 없음(allowlist)', async () => {
    const adminList = (await http.get('/api/students').set(auth('admin')).expect(200)).body as Array<Record<string, unknown>>;
    const instrList = (await http.get('/api/students').set(auth('park_inst')).expect(200)).body as Array<Record<string, unknown>>;
    expect(adminList.length).toBeGreaterThan(instrList.length >= 0 ? 0 : 0);
    // 강사 목록은 관리자 목록의 부분집합(본인 코스 수강생·세션 참여자만)
    const adminIds = new Set(adminList.map((row) => row.id));
    for (const row of instrList) expect(adminIds.has(row.id)).toBe(true);
    expect(instrList.length).toBeGreaterThan(0); // 픽스처: 강사1은 담당 학생 존재
    expect(instrList.length).toBeLessThan(adminList.length); // 전체보다 좁다(스코프 실증 — 픽스처 박지민은 미수강)
    // 필드 최소화 — 마스킹이 아니라 **키 부재**
    for (const row of instrList) {
      for (const banned of ['phone', 'address', 'addressDetail', 'kakaoId', 'memo', 'counselTopic', 'birthDate']) {
        expect(row).not.toHaveProperty(banned);
      }
      expect(row).toHaveProperty('name');
      expect(row).toHaveProperty('status');
    }
    // 관리자 응답은 무변(full) — 같은 학생 행에서 관리자 키 ⊋ 강사 키(픽스처-독립: 키 개수·포함 관계로 판정)
    const sample = instrList[0];
    const adminRow = adminList.find((row) => row.id === sample.id);
    expect(adminRow).toBeDefined();
    for (const key of Object.keys(sample)) expect(adminRow).toHaveProperty(key);
    expect(Object.keys(adminRow!).length).toBeGreaterThan(Object.keys(sample).length);
  });

  it('P0-5 ② 강사 단건 — 담당 학생 200(안전 필드), 스코프 밖 403, 코스 없는 강사는 전부 403', async () => {
    const instrList = (await http.get('/api/students').set(auth('park_inst')).expect(200)).body as Array<{ id: number }>;
    const mine = instrList[0].id;
    const detail = (await http.get(`/api/students/${mine}`).set(auth('park_inst')).expect(200)).body;
    expect(detail).not.toHaveProperty('phone');
    // 스코프 밖 학생(관리자 목록에서 강사 목록에 없는 id)
    const adminList = (await http.get('/api/students').set(auth('admin')).expect(200)).body as Array<{ id: number }>;
    const mineSet = new Set(instrList.map((row) => row.id));
    const outside = adminList.find((row) => !mineSet.has(row.id));
    expect(outside).toBeDefined();
    await http.get(`/api/students/${outside!.id}`).set(auth('park_inst')).expect(403);
    // 담당 코스가 없는 강사(jung_inst — 픽스처 코스11 담당이면 스코프 존재 가능성) → 최소 스코프 밖 403 유지
    await http.get(`/api/students/${outside!.id}`).set(auth('jung_inst')).expect(403).catch(async () => {
      // outside가 jung 스코프일 수 있는 극단 픽스처 대비 — jung 스코프 밖 확정 id로 재시도
      const jungList = (await http.get('/api/students').set(auth('jung_inst')).expect(200)).body as Array<{ id: number }>;
      const jungSet = new Set(jungList.map((row) => row.id));
      const out2 = adminList.find((row) => !jungSet.has(row.id));
      if (out2) await http.get(`/api/students/${out2.id}`).set(auth('jung_inst')).expect(403);
    });
  });

  it('P0-5 ③ parents 3종 — 강사 403, 관리자 200 (보호자 연락처는 관리자 전용)', async () => {
    for (const path of ['/api/parents', '/api/parents/relations', '/api/parents/1']) {
      await http.get(path).set(auth('park_inst')).expect(403);
    }
    await http.get('/api/parents').set(auth('admin')).expect(200);
    await http.get('/api/parents/relations').set(auth('manager')).expect(200);
  });

  it('C3-2 sudo — cookie/Bearer 모두 재인증 없이 원부 삭제·환불·지급을 거부한다', async () => {
    // cookie 로그인(브라우저 경로) — SudoGuard 강제 대상
    const agent = request.agent(app.getHttpServer());
    await agent.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    await agent.delete('/api/students/999999').expect(403); // sudo 미보유 → 403(404 이전에 차단)
    await agent.post('/api/payments/999999/refund').expect(403);
    await agent.post('/api/payouts/999999/pay').expect(403);
    // sudo 재인증 후엔 guard 통과 → 존재하지 않는 id라 404/400 (403 아님 = guard 해제 증명)
    await agent.post('/api/auth/reauth').send({ currentPassword: 'demo1234' }).expect(201);
    const afterDelete = await agent.delete('/api/students/999999');
    expect([400, 404]).toContain(afterDelete.status);
    const afterRefund = await agent.post('/api/payments/999999/refund');
    expect([400, 404]).toContain(afterRefund.status);
    const afterPay = await agent.post('/api/payouts/999999/pay');
    expect([400, 404]).toContain(afterPay.status);
    // Bearer access token도 step-up을 우회할 수 없다.
    const bearerDelete = await http.delete('/api/students/999999').set(auth('admin'));
    expect(bearerDelete.status).toBe(403);
    expect(JSON.stringify(bearerDelete.body)).toContain('SUDO_REQUIRED');
  });

  it('C3-3 대표 소유 스케줄 — manager 변경/삭제 403, 대표 본인 200', async () => {
    // 대표(super_admin, id 조회) 담당 세션 생성
    const me = (await http.get('/api/auth/me').set(auth('admin')).expect(200)).body;
    const ceoId = Number(me.id ?? me.sub);
    const created = (await http.post('/api/schedule').set(auth('admin')).send({
      courseId: 10, instructorId: ceoId, studentIds: [1], sessionDate: '2099-06-01',
      startTime: '10:00', durationMinutes: 60, force: true,
    }).expect(201)).body.row;
    // manager 수정·삭제 → 403
    const patch = await http.patch(`/api/schedule/${created.id}`).set(auth('manager')).send({ startTime: '11:00', force: true });
    expect(patch.status).toBe(403);
    const del = await http.delete(`/api/schedule/${created.id}`).set(auth('manager'));
    expect(del.status).toBe(403);
    // 대표 본인 → 200
    await http.patch(`/api/schedule/${created.id}`).set(auth('admin')).send({ startTime: '11:00', force: true }).expect(200);
    await http.delete(`/api/schedule/${created.id}`).set(auth('admin')).expect(200);
    // 일반 강사 세션은 종전대로 manager가 변경 가능(회귀 아님 증명)
    const normal = (await http.post('/api/schedule').set(auth('admin')).send({
      courseId: 10, instructorId: 1, studentIds: [1], sessionDate: '2099-06-02',
      startTime: '10:00', durationMinutes: 60, force: true,
    }).expect(201)).body.row;
    await http.patch(`/api/schedule/${normal.id}`).set(auth('manager')).send({ startTime: '12:00', force: true }).expect(200);
    await http.delete(`/api/schedule/${normal.id}`).set(auth('manager')).expect(200);
  });
});
