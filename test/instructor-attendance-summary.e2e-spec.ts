import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// [TBO-19] 강사 출결 현황 집계(관리자 대시보드) — 기간·강사 필터·카운트·시수·총계·권한.
const JUN1 = '2026-06-01';
const JUN30 = '2026-06-30';

describe('강사 출결 현황 집계 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => app.close());

  const token = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const summary = async (t: string, q: string) =>
    (await http.get(`/api/schedule/instructor-attendance-summary?${q}`).set(auth(t)).expect(200)).body;

  it('관리자: 6월 집계 — 강사별 카운트·시수·총계', async () => {
    const admin = await token('admin');
    const s = await summary(admin, `from=${JUN1}&to=${JUN30}`);
    expect(Array.isArray(s.rows)).toBe(true);
    expect(s.totals.held).toBeGreaterThan(0);
    const r1 = s.rows.find((r: { instructorId: number }) => r.instructorId === 1);
    expect(r1).toBeTruthy();
    expect(r1.teachingHours).toBeGreaterThan(0);
  });

  it('강사 필터 — 해당 강사만', async () => {
    const admin = await token('admin');
    const s = await summary(admin, `from=${JUN1}&to=${JUN30}&instructorId=1`);
    expect(s.rows.every((r: { instructorId: number }) => r.instructorId === 1)).toBe(true);
  });

  it('강사 결석 마킹 반영 — absent +1, 인정 시수 감소', async () => {
    const admin = await token('admin');
    const before = (await summary(admin, `from=${JUN1}&to=${JUN30}&instructorId=1`)).rows[0];
    const held = (await http.get(`/api/schedule?from=${JUN1}&to=${JUN30}&instructorId=1`).set(auth(admin)).expect(200)).body
      .filter((x: { status: string }) => x.status === 'held');
    const sid = held[0].id;
    await http.patch(`/api/schedule/${sid}`).set(auth(admin)).send({ instructorAttendance: 'absent' }).expect(200);
    const after = (await summary(admin, `from=${JUN1}&to=${JUN30}&instructorId=1`)).rows[0];
    expect(after.absent).toBe(before.absent + 1);
    expect(after.teachingHours).toBeLessThan(before.teachingHours);
  });

  it('강사 권한 차단(403 — 관리 지표)', async () => {
    const inst = await token('park_inst');
    await http.get(`/api/schedule/instructor-attendance-summary?from=${JUN1}&to=${JUN30}`).set(auth(inst)).expect(403);
  });
});
