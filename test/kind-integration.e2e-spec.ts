// [B5 2026-07-16 대표 결정 ③] 일반수업+진단고사(level_test)+상담(counsel)+학원 일정(모의고사=exam)이
//  한 캘린더에서 관리되고, 세션 kind는 일반 수업과 **같은 참조 무결성**(FK·코호트·충돌)을 탄다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Calendar kind integration (e2e, B5)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin = '';
  const auth = () => ({ Authorization: `Bearer ${admin}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('진단고사(level_test)도 일반 수업과 같은 FK 검증·충돌 검사·kind 영속을 탄다', async () => {
    // 유령 코스 → 400 (kind와 무관한 공통 무결성)
    await http.post('/api/schedule').set(auth()).send({
      courseId: 999999, sessionDate: '2026-06-05', startTime: '05:00', durationMinutes: 60, kind: 'level_test',
    }).expect(400);

    const created = (await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-05', startTime: '05:00', durationMinutes: 60,
      kind: 'level_test', studentIds: [1], topic: '레벨 진단', force: true,
    }).expect(201)).body.row;
    expect(created.kind).toBe('level_test');

    // 같은 시간 같은 강사 상담(counsel) → 강사 이중예약 충돌(kind가 달라도 시간 점유는 동일 규칙)
    const conflicted = await http.post('/api/schedule').set(auth()).send({
      courseId: 10, instructorId: 1, sessionDate: '2026-06-05', startTime: '05:30', durationMinutes: 60,
      kind: 'counsel', studentIds: [1],
    }).expect(409);
    expect(conflicted.body.conflicts.some((c: { resource: string }) => c.resource === 'instructor')).toBe(true);

    // 캘린더 목록에서 kind 혼합 반환(한 곳 관리)
    const list = (await http.get('/api/schedule?from=2026-06-05&to=2026-06-05').set(auth()).expect(200)).body;
    expect(list.some((r: { id: number; kind: string }) => r.id === created.id && r.kind === 'level_test')).toBe(true);
  });

  it('학원 일정(모의고사=exam) 발행·구간 무결성 — 매니저 이상, 종료<시작 400', async () => {
    await http.post('/api/events').set(auth()).send({
      title: 'B5 모의고사', type: 'exam', priority: 'high', startDate: '2026-06-10', endDate: '2026-06-09',
    }).expect(400); // endDate ≥ startDate 무결성(서비스+DB CHECK 이중 방어)
    const ev = (await http.post('/api/events').set(auth()).send({
      title: 'B5 모의고사', type: 'exam', priority: 'high', startDate: '2026-06-10', endDate: '2026-06-10',
    }).expect(201)).body;
    expect(ev.type).toBe('exam');
    const list = (await http.get('/api/events').set(auth()).expect(200)).body;
    expect(list.some((e: { id: number }) => e.id === ev.id)).toBe(true);
  });
});
