import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mondayISO, addDaysISO } from './setup-app';

// 스케줄 API e2e — 참조 무결성(FK)·충돌(409/force)·시리즈 스코프·학생 코호트 필터 중심.
describe('Schedule API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const MON = mondayISO();
  const SUN = addDaysISO(MON, 6);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => { await app.close(); });

  it('GET /schedule — enriched 행(요일·라벨·코호트 studentIds 포함)', async () => {
    const res = await http.get(`/api/schedule?from=${MON}&to=${SUN}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const r = res.body[0];
    expect(r).toHaveProperty('courseName');
    expect(r).toHaveProperty('instructorName');
    expect(Array.isArray(r.studentIds)).toBe(true);
    expect(Array.isArray(r.studentNames)).toBe(true);
  });

  it('GET /schedule/resources — 강사·강의실·학생·코스 옵션', async () => {
    const res = await http.get('/api/schedule/resources').expect(200);
    expect(res.body.instructors.length).toBeGreaterThan(0);
    expect(res.body.rooms.length).toBeGreaterThan(0);
    expect(res.body.students.length).toBeGreaterThan(0);
    expect(res.body.courses.length).toBeGreaterThan(0);
    // 코스 옵션은 강사 FK와 정렬되어 있어야 함
    for (const c of res.body.courses) {
      expect(res.body.instructors.some((i: { id: number }) => i.id === c.instructorId)).toBe(true);
    }
  });

  it('GET /schedule?studentId=2 — 학생2 코호트(코스11) 세션만', async () => {
    const res = await http.get(`/api/schedule?from=${MON}&to=${SUN}&studentId=2`).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const r of res.body) {
      expect(r.courseId).toBe(11);
      expect(r.studentIds).toContain(2);
    }
  });

  it('POST /schedule — 빈 슬롯 생성 성공(FK·시각 파생)', async () => {
    const res = await http.post('/api/schedule')
      .send({ courseId: 10, sessionDate: addDaysISO(MON, 1), startTime: '10:00', durationMinutes: 60 })
      .expect(201);
    expect(res.body.row).toMatchObject({ courseId: 10, startTime: '10:00', endTime: '11:00' });
    expect(res.body.row.instructorName).toBeTruthy();
    expect(res.body.conflicts).toEqual([]);
  });

  it('POST /schedule — 존재하지 않는 courseId → 400(참조 무결성)', async () => {
    await http.post('/api/schedule')
      .send({ courseId: 999, sessionDate: addDaysISO(MON, 1), startTime: '09:00', durationMinutes: 60 })
      .expect(400);
  });

  it('POST /schedule — 존재하지 않는 roomId → 400(참조 무결성)', async () => {
    await http.post('/api/schedule')
      .send({ courseId: 10, roomId: 9999, sessionDate: addDaysISO(MON, 1), startTime: '09:00', durationMinutes: 60 })
      .expect(400);
  });

  it('POST /schedule — 강사 이중예약(시드 월 16:00) → 409 conflicts', async () => {
    const res = await http.post('/api/schedule')
      .send({ courseId: 10, sessionDate: MON, startTime: '16:00', durationMinutes: 90 })
      .expect(409);
    const conflicts = res.body.conflicts ?? res.body.message?.conflicts ?? [];
    expect(JSON.stringify(res.body)).toContain('double_book');
  });

  it('POST /schedule — force=true면 충돌이 있어도 생성', async () => {
    const res = await http.post('/api/schedule')
      .send({ courseId: 10, sessionDate: MON, startTime: '16:00', durationMinutes: 90, force: true })
      .expect(201);
    expect(res.body.row.id).toBeGreaterThan(0);
    expect(res.body.conflicts.length).toBeGreaterThan(0); // 충돌은 보고됨
  });

  it('POST /schedule — 강사 불가시간(시드 월 12:00-13:00) 침범 → 409 unavailable', async () => {
    const res = await http.post('/api/schedule')
      .send({ courseId: 10, sessionDate: MON, startTime: '12:30', durationMinutes: 30 })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('unavailable');
  });

  it('PATCH /schedule/:id — 존재하지 않는 roomId → 400(참조 무결성)', async () => {
    const list = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).expect(200)).body;
    const id = list[0].id;
    await http.patch(`/api/schedule/${id}`).send({ roomId: 9999 }).expect(400);
  });

  it('PATCH /schedule/:id — 시리즈 전체(scope=all) 동반 이동(updated>1)', async () => {
    // 시드: 코스10 시리즈(월·수·금) — 한 세션을 빈 시각으로 옮기되 scope=all
    const list = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).expect(200)).body;
    const target = list.find((r: { courseId: number; seriesId?: number }) => r.courseId === 10 && r.seriesId != null);
    expect(target).toBeTruthy();
    const res = await http.patch(`/api/schedule/${target.id}`)
      .send({ startTime: '09:00', endTime: '10:00', scope: 'all', force: true })
      .expect(200);
    expect(res.body.updated).toBeGreaterThan(1);
  });
});
