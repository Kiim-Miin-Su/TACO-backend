// [B4 2026-07-16 대표 결정 ②] 강의실 정원 서버 강제 + 강의실 CRUD(매니저 이상).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

describe('Room capacity enforcement + rooms CRUD (e2e, B4)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  const auth = () => ({ Authorization: `Bearer ${admin}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('정원 1 강의실에 2명 배정 → room_capacity 409, force로 강제 가능, 정원 상향 후 통과', async () => {
    // 기본 정원 1(capacity 미지정) — 대표 결정 ②
    const room = (await http.post('/api/rooms').set(auth()).send({ name: '정원검증실' }).expect(201)).body;
    expect(room.capacity).toBe(1);

    // 코스 10 활성 수강생 = 학생 1·4(시드) → 명시 코호트 2명 배정 시 정원 초과
    const body = {
      courseId: 10, instructorId: 1, sessionDate: '2026-06-01', startTime: '05:00',
      durationMinutes: 60, roomId: room.id, studentIds: [1, 4],
    };
    const blocked = await http.post('/api/schedule').set(auth()).send(body).expect(409);
    expect(blocked.body.conflicts.some((c: { type: string; resource: string }) => c.type === 'room_capacity' && c.resource === 'room')).toBe(true);
    const detail = blocked.body.conflicts.find((c: { type: string }) => c.type === 'room_capacity').detail;
    expect(detail).toContain('정원 1명');
    expect(detail).toContain('배정 2명');

    // force=true — 관리자가 알고 강제(기존 충돌 규약과 동일)
    const forced = (await http.post('/api/schedule').set(auth()).send({ ...body, force: true }).expect(201)).body.row;
    await http.delete(`/api/schedule/${forced.id}`).set(auth()).expect(200);

    // 정원 2로 상향(PATCH — 매니저 이상) → 같은 배정이 충돌 없이 통과
    const updated = (await http.patch(`/api/rooms/${room.id}`).set(auth()).send({ capacity: 2 }).expect(200)).body;
    expect(updated.capacity).toBe(2);
    const ok = (await http.post('/api/schedule').set(auth()).send({ ...body, startTime: '05:00' }).expect(201)).body;
    expect(ok.conflicts.filter((c: { type: string }) => c.type === 'room_capacity')).toHaveLength(0);

    // 정원 변경은 audit diff 이력 필수
    const audits = db.findAll<{ entity: string; entityId: number; action: string; changes?: Record<string, { before?: unknown; after?: unknown }> }>('audit_log')
      .filter((a) => a.entity === 'rooms' && a.entityId === room.id);
    expect(audits.map((a) => a.action)).toEqual(['create', 'update']);
    expect(audits[1].changes?.capacity).toEqual({ before: 1, after: 2 });
  });

  it('1명 배정은 정원 1에서 통과(경계) · 강의실 삭제는 소프트(목록 제외)+snapshot audit', async () => {
    const room = (await http.post('/api/rooms').set(auth()).send({ name: '경계검증실' }).expect(201)).body;
    const ok = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-02', startTime: '05:00',
      durationMinutes: 60, roomId: room.id, studentIds: [1],
    }).expect(201)).body;
    expect(ok.conflicts.filter((c: { type: string }) => c.type === 'room_capacity')).toHaveLength(0);

    await http.delete(`/api/rooms/${room.id}`).set(auth()).expect(200);
    const list = (await http.get('/api/rooms').set(auth()).expect(200)).body;
    expect(list.some((r: { id: number }) => r.id === room.id)).toBe(false);
    const del = db.findAll<{ entity: string; entityId: number; action: string }>('audit_log')
      .filter((a) => a.entity === 'rooms' && a.entityId === room.id && a.action === 'delete');
    expect(del).toHaveLength(1);
  });

  it('강의실 CRUD 권한 — 강사는 403(매니저 이상 전용)', async () => {
    const inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.post('/api/rooms').set('Authorization', `Bearer ${inst}`).send({ name: 'x' }).expect(403);
    await http.patch('/api/rooms/1').set('Authorization', `Bearer ${inst}`).send({ capacity: 3 }).expect(403);
    await http.delete('/api/rooms/1').set('Authorization', `Bearer ${inst}`).expect(403);
  });
});
