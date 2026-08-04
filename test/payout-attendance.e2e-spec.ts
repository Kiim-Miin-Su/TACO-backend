import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { clearInstructorAttendanceAckingImpact, createTestApp, setInstructorAttendanceAckingImpact } from './setup-app';

// [TBO-19 시수 정책] 강사 결석(instructorAttendance='absent') 세션은 정산 시수에서 제외됨을 검증.
//  잠정 비즈니스 로직 — payouts.service.measure() 게이트 (1-b)와 한 쌍.
const JUN1 = '2026-06-01';
const JUN30 = '2026-06-30';

describe('Payouts 시수 정책 — 강사 결석 제외 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const login = await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201);
    ADMIN = login.body.accessToken;
  });
  afterAll(async () => {
    await app.close();
  });

  it('강사 결석 세션은 preview 시수에서 제외 → 복구 시 재포함', async () => {
    // 베이스라인: 강사1 적격 3건(held+승인보고서)
    const base = (await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).set(asAdmin()).expect(200)).body;
    expect(base.sessionCount).toBe(3);
    const target = base.lines[0]; // 적격 세션 하나 선택
    expect(target.sessionId).toBeTruthy();

    // 강사 결석 마킹 → 그 세션이 시수에서 빠짐
    expect((await setInstructorAttendanceAckingImpact(http, asAdmin(), target.sessionId, 'absent')).status).toBe(200);
    const afterAbsent = (await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).set(asAdmin()).expect(200)).body;
    expect(afterAbsent.sessionCount).toBe(2);
    expect(afterAbsent.totalMinutes).toBe(base.totalMinutes - target.durationMinutes);

    // 출석(present)으로 복구 → 다시 3건
    expect((await setInstructorAttendanceAckingImpact(http, asAdmin(), target.sessionId, 'present')).status).toBe(200);
    const restored = (await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).set(asAdmin()).expect(200)).body;
    expect(restored.sessionCount).toBe(3);
    expect(restored.totalMinutes).toBe(base.totalMinutes);
  });

  it('강사 출결 초기화(clear) — 미표시+scheduled로 역전이되어 시수에서 제외', async () => {
    const base = (await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).set(asAdmin()).expect(200)).body;
    const sid = base.lines[0].sessionId;
    // 결석 마킹 → 제외
    expect((await setInstructorAttendanceAckingImpact(http, asAdmin(), sid, 'absent')).status).toBe(200);
    expect((await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).set(asAdmin()).expect(200)).body.sessionCount).toBe(2);
    // 초기화(clear) → 미표시 + held→scheduled. 출결 사실이 미완결이므로 시수 제외 유지.
    expect((await clearInstructorAttendanceAckingImpact(http, asAdmin(), sid)).status).toBe(200);
    const sessions = (await http.get(`/api/schedule?from=${JUN1}&to=${JUN30}`).set(asAdmin()).expect(200)).body;
    const s = sessions.find((x: { id: number }) => x.id === sid);
    expect(s.instructorAttendance == null).toBe(true); // 미표시로 비워짐
    expect(s.status).toBe('scheduled');
    expect((await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).set(asAdmin()).expect(200)).body.sessionCount).toBe(2);
  });
});
