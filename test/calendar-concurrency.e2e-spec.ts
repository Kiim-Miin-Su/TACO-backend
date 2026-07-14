// [TBO-28C] 캘린더 target 직렬화·무결성 e2e — TBO-28 §28C 종료 조건.
//  in-memory 모드(CI 상시): 메모리 tx 전역 큐가 직렬화. Postgres 모드(28F): advisory lock이 직렬화 —
//  동일 스펙을 DATABASE_URL로 재실행해 두 모드 모두 증명한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AuditService } from '../src/modules/audit/audit.service';

describe('Calendar concurrency + integrity (e2e, TBO-28C)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let ADMIN = '';
  let INST = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });
  const asInst = () => ({ Authorization: `Bearer ${INST}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    INST = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  const sessionsOn = async (date: string) =>
    (await http.get(`/api/schedule?from=${date}&to=${date}`).set(asAdmin()).expect(200)).body as Array<{ id: number; topic?: string }>;

  it('동시 create(같은 강사·시간) — 성공 1 · 409 1, 세션·audit 정확 1건', async () => {
    const body = { courseId: 10, sessionDate: '2099-06-08', startTime: '09:00', endTime: '10:00', topic: '동시생성A' };
    const [a, b] = await Promise.all([
      http.post('/api/schedule').set(asAdmin()).send(body),
      http.post('/api/schedule').set(asAdmin()).send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rows = (await sessionsOn('2099-06-08')).filter((r) => r.topic === '동시생성A');
    expect(rows).toHaveLength(1);
    const audits = db.findAll<{ id: number; entity: string; entityId: number; action: string }>('audit_log')
      .filter((x) => x.entity === 'class_sessions' && x.entityId === rows[0].id && x.action === 'create');
    expect(audits).toHaveLength(1);
  });

  it('동시 create(다른 자원) — 둘 다 201(직렬화가 커밋을 잃지 않음)', async () => {
    const [a, b] = await Promise.all([
      http.post('/api/schedule').set(asAdmin()).send({ courseId: 10, instructorId: 1, roomId: 1, sessionDate: '2099-06-09', startTime: '09:00', endTime: '10:00', topic: '병렬A' }),
      http.post('/api/schedule').set(asAdmin()).send({ courseId: 11, instructorId: 2, roomId: 2, sessionDate: '2099-06-09', startTime: '09:00', endTime: '10:00', topic: '병렬B' }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const rows = await sessionsOn('2099-06-09');
    expect(rows.filter((r) => r.topic === '병렬A')).toHaveLength(1);
    expect(rows.filter((r) => r.topic === '병렬B')).toHaveLength(1);
  });

  it('서로 다른 두 요청이 같은 자원·시간 — 동시 승인 시 성공 1 · 409 1(패자 요청은 pending 유지)', async () => {
    const slot = { courseId: 10, sessionDate: '2099-06-10', startTime: '11:00', endTime: '12:00' };
    const r1 = (await http.post('/api/schedule-requests').set(asInst()).send({ ...slot, topic: '요청1' }).expect(201)).body.row;
    const r2 = (await http.post('/api/schedule-requests').set(asInst()).send({ ...slot, topic: '요청2' }).expect(201)).body.row;
    const [a, b] = await Promise.all([
      http.post(`/api/schedule-requests/${r1.id}/approve`).set(asAdmin()),
      http.post(`/api/schedule-requests/${r2.id}/approve`).set(asAdmin()),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await sessionsOn('2099-06-10')).filter((r) => r.topic === '요청1' || r.topic === '요청2')).toHaveLength(1);
    // 패자 요청은 원자 롤백으로 pending 유지(재승인 가능 상태)
    const pending = (await http.get('/api/schedule-requests?status=pending').set(asAdmin()).expect(200)).body as Array<{ id: number }>;
    const loserId = a.status === 409 ? r1.id : r2.id;
    expect(pending.some((r) => r.id === loserId)).toBe(true);
  });

  it('학생 세션 간 중복 — 강사·강의실이 달라도 같은 학생이 겹치면 409(double_book/student, 대상 식별)', async () => {
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, roomId: 1, sessionDate: '2099-06-11', startTime: '14:00', endTime: '15:00', studentIds: [1], topic: '학생중복A' })
      .expect(201);
    const res = await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 12, instructorId: 2, roomId: 2, sessionDate: '2099-06-11', startTime: '14:30', endTime: '15:30', studentIds: [1], topic: '학생중복B' });
    expect(res.status).toBe(409);
    const conflicts = res.body.conflicts as Array<{ type: string; resource?: string; resourceId?: number; sessionId?: number }>;
    const stu = conflicts.find((c) => c.type === 'double_book' && c.resource === 'student');
    expect(stu).toBeDefined();
    expect(stu!.resourceId).toBe(1); // 어느 학생인지 식별
    expect(stu!.sessionId).toBeGreaterThan(0); // 어느 수업과 겹치는지 식별
    // 다른 학생이면 통과
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 2, roomId: 2, sessionDate: '2099-06-11', startTime: '14:30', endTime: '15:30', studentIds: [4], topic: '학생중복C', force: false })
      .expect(201);
  });

  it('자정 크로스 스필 — 익일 새벽 불가시간 추가가 크로스 수업 영향으로 감지(409 approvalRequired)', async () => {
    // 크로스 세션: 23:00 → 익일 01:00 (강사 1)
    const made = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: '2099-06-15', startTime: '23:00', endTime: '01:00', topic: '자정크로스' })
      .expect(201)).body.row;
    // 익일(06-16) 요일의 00:00-02:00 불가시간을 강사 본인이 추가 시도 → 스필 구간과 겹침 → 승인 필요
    const nextWeekday = new Date('2099-06-16T00:00:00Z').getUTCDay();
    const res = await http.put('/api/availability').set(asInst()).send({
      ownerType: 'instructor', ownerId: 1, kind: 'unavailable',
      weekday: nextWeekday, startTime: '00:30', endTime: '02:00',
    });
    expect(res.status).toBe(409);
    expect(res.body.approvalRequired).toBe(true);
    expect((res.body.impactedSessions as Array<{ sessionId: number }>).some((x) => x.sessionId === made.id)).toBe(true);
    // 블록은 저장되지 않았다
    const blocks = (await http.get('/api/availability?ownerType=instructor&ownerId=1').set(asAdmin()).expect(200)).body as Array<{ weekday: number; startTime: string }>;
    expect(blocks.some((b) => b.weekday === nextWeekday && b.startTime === '00:30')).toBe(false);
    // 관리자는 동일 변경 직접 반영 가능(기존 규약 유지)
    await http.put('/api/availability').set(asAdmin()).send({
      ownerType: 'instructor', ownerId: 1, kind: 'unavailable',
      weekday: nextWeekday, startTime: '00:30', endTime: '02:00',
    }).expect(200);
    // 이제 같은 시간대 크로스 세션 신규 생성은 익일 세그먼트 충돌로 409 (conflict.util 이틀 검사)
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: '2099-06-15', startTime: '23:30', endTime: '01:00', topic: '크로스재시도' })
      .expect(409);
  });

  it('실패 주입 rollback — audit 실패 시 세션 미잔존, 이후 커밋은 정상(스냅샷이 남의 커밋을 삼키지 않음)', async () => {
    const audit = app.get(AuditService);
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected calendar audit failure'));
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-06-18', startTime: '09:00', endTime: '10:00', topic: '롤백검증' })
      .expect(500);
    spy.mockRestore();
    expect((await sessionsOn('2099-06-18')).filter((r) => r.topic === '롤백검증')).toHaveLength(0);
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-06-18', startTime: '09:00', endTime: '10:00', topic: '롤백검증' })
      .expect(201);
    expect((await sessionsOn('2099-06-18')).filter((r) => r.topic === '롤백검증')).toHaveLength(1);
  });
});
