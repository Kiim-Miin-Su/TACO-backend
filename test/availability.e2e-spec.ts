import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 가용/불가(Block) CRUD e2e + 스케줄 충돌 연동(불가시간 침범 차단).
describe('Availability API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => { await app.close(); });

  it('PUT /availability — 학생 가용시간 생성', async () => {
    const res = await http.put('/api/availability')
      .send({ ownerType: 'student', ownerId: 1, kind: 'available', weekday: 1, startTime: '16:00', endTime: '18:00' })
      .expect(200);
    expect(res.body.id).toBeGreaterThan(0);
    expect(res.body).toMatchObject({ ownerType: 'student', ownerId: 1, kind: 'available' });
  });

  it('GET /availability?ownerType=student&ownerId=1 — 필터 조회', async () => {
    const res = await http.get('/api/availability?ownerType=student&ownerId=1').expect(200);
    expect(res.body.every((b: { ownerType: string; ownerId: number }) => b.ownerType === 'student' && b.ownerId === 1)).toBe(true);
  });

  it('참조 무결성(#7): 존재하지 않는 강의실 owner → 400', async () => {
    await http.put('/api/availability')
      .send({ ownerType: 'room', ownerId: 9999, kind: 'unavailable', weekday: 2, startTime: '10:00', endTime: '11:00' })
      .expect(400);
  });

  it('PUT(id) → 수정, DELETE → 삭제', async () => {
    const created = (await http.put('/api/availability')
      .send({ ownerType: 'room', ownerId: 1, kind: 'unavailable', weekday: 3, startTime: '09:00', endTime: '10:00' })
      .expect(200)).body;
    // 수정(끝시간 연장)
    const updated = (await http.put('/api/availability')
      .send({ id: created.id, ownerType: 'room', ownerId: 1, kind: 'unavailable', weekday: 3, startTime: '09:00', endTime: '11:00' })
      .expect(200)).body;
    expect(updated.id).toBe(created.id);
    expect(updated.endTime).toBe('11:00');
    // 삭제
    const del = (await http.delete(`/api/availability/${created.id}`).expect(200)).body;
    expect(del).toMatchObject({ id: created.id, deleted: true });
  });

  it('불가시간 신설 후 그 위 세션 생성 → 409 unavailable (가용↔충돌 연동)', async () => {
    // 강의실1 수요일 14:00-15:00 차단
    const wed = weekdayDateThisWeek(3);
    await http.put('/api/availability')
      .send({ ownerType: 'room', ownerId: 1, kind: 'unavailable', weekday: 3, startTime: '14:00', endTime: '15:00' })
      .expect(200);
    const res = await http.post('/api/schedule')
      .send({ courseId: 10, roomId: 1, sessionDate: wed, startTime: '14:00', durationMinutes: 60 })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('unavailable');
  });
});

// 현재 주의 특정 요일(0=일~6=토) 날짜
function weekdayDateThisWeek(weekday: number): string {
  const d = new Date();
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = u.getUTCDay();
  u.setUTCDate(u.getUTCDate() + (dow === 0 ? -6 : 1 - dow)); // 월요일
  u.setUTCDate(u.getUTCDate() + (weekday === 0 ? 6 : weekday - 1));
  return u.toISOString().slice(0, 10);
}
