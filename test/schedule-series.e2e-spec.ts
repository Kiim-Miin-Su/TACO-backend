// [TBO-29C C2] 반복 생성 bulk command e2e — 서버 발급 series ID·규칙 자산화·전체 원자성.
//  in-memory(CI 상시) + DATABASE_URL 재실행(PG advisory lock·FK)의 이중 모드 스펙.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AuditService } from '../src/modules/audit/audit.service';
import { ClassSessionsStore } from '../src/modules/schedule/class-sessions.store';
import { CLASS_SESSION_SERIES } from '../src/modules/schedule/schedule-series.entity';

describe('Schedule series bulk create (e2e, TBO-29C C2)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let ADMIN = '';
  let INST = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });
  const asInst = () => ({ Authorization: `Bearer ${INST}` });

  // 2099-07-06(월)~2099-07-19(일) 2주 — 시드와 절대 겹치지 않는 미래 구간.
  const STARTS = '2099-07-06';
  const ENDS = '2099-07-19';
  const MONDAY = 1;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    INST = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  const seriesRows = () => db.findAll<{ id: number; weekdays: number[]; version: number }>(CLASS_SESSION_SERIES);
  const sessionsBetween = async (from: string, to: string) =>
    (await http.get(`/api/schedule?from=${from}&to=${to}`).set(asAdmin()).expect(200)).body as Array<{ id: number; seriesId?: number; sessionDate: string; topic?: string; startTime?: string; durationMinutes?: number }>;
  const auditCount = (entity: string, action: string) =>
    db.findAll<{ entity: string; action: string }>('audit_log').filter((x) => x.entity === entity && x.action === action).length;

  const cmd = (over: Record<string, unknown> = {}) => ({
    courseId: 10,
    instructorId: 1,
    repeat: { kind: 'weekly', weekdays: [MONDAY], startsOn: STARTS, endsOn: ENDS },
    startTime: '09:00',
    endTime: '10:00',
    topic: '시리즈생성',
    ...over,
  });

  it('weekly 2주 — 서버가 series ID 발급, 회차 전체 생성, 규칙 자산화, audit(series 1 + session N)', async () => {
    const before = { series: seriesRows().length, seriesAudit: auditCount(CLASS_SESSION_SERIES, 'create'), sessionAudit: auditCount('class_sessions', 'create') };
    const res = await http.post('/api/schedule/series').set(asAdmin()).send(cmd()).expect(201);
    const { series, rows, conflicts } = res.body as { series: { id: number; repeatKind: string; weekdays: number[]; startsOn: string; endsOn: string; version: number; createdBy?: number }; rows: Array<{ id: number; seriesId: number; sessionDate: string }>; conflicts: unknown[] };
    expect(series.id).toBeGreaterThan(0);
    expect(series.repeatKind).toBe('weekly');
    expect(series.weekdays).toEqual([MONDAY]);
    expect(series.version).toBe(1);
    expect(series.createdBy).toBeGreaterThan(0); // 생성자 자산화
    expect(rows).toHaveLength(2); // 07-06, 07-13
    expect(rows.map((r) => r.sessionDate)).toEqual(['2099-07-06', '2099-07-13']);
    expect(rows.every((r) => r.seriesId === series.id)).toBe(true);
    expect(conflicts).toHaveLength(0);
    expect(seriesRows().length).toBe(before.series + 1);
    expect(auditCount(CLASS_SESSION_SERIES, 'create')).toBe(before.seriesAudit + 1);
    expect(auditCount('class_sessions', 'create')).toBe(before.sessionAudit + 2);
    // readback — 저장된 회차가 조회로 복원
    const listed = (await sessionsBetween(STARTS, ENDS)).filter((r) => r.seriesId === series.id);
    expect(listed).toHaveLength(2);
  });

  it('정규화 거부 — weekly 요일 2개/기간 역전/미지원 시간대/기간 내 요일 없음 = 400', async () => {
    await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ repeat: { kind: 'weekly', weekdays: [1, 3], startsOn: STARTS, endsOn: ENDS } })).expect(400);
    await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ repeat: { kind: 'weekly', weekdays: [1], startsOn: ENDS, endsOn: STARTS } })).expect(400);
    await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ timeZone: 'America/New_York' })).expect(400);
    await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ repeat: { kind: 'custom', weekdays: [3], startsOn: '2099-07-06', endsOn: '2099-07-07' } })).expect(400);
  });

  it('전체 conflict 선계산 — 한 회차라도 충돌이면 409 + 전체 목록, series/sessions/audit +0', async () => {
    // 두 번째 발생일(07-13) 자리에 단건 세션 선점
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, sessionDate: '2099-07-13', startTime: '11:00', endTime: '12:00', topic: '선점' })
      .expect(201);
    const before = { series: seriesRows().length, audit: auditCount('class_sessions', 'create') };
    const res = await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ startTime: '11:00', endTime: '12:00', topic: '충돌시리즈' })).expect(409);
    const conflicts = res.body.conflicts as Array<{ type: string; sessionId?: number }>;
    expect(conflicts.length).toBeGreaterThan(0);
    expect(seriesRows().length).toBe(before.series); // series +0
    const saved = (await sessionsBetween(STARTS, ENDS)).filter((r) => r.topic === '충돌시리즈');
    expect(saved).toHaveLength(0); // sessions +0
    expect(auditCount('class_sessions', 'create')).toBe(before.audit); // audit +0
    // force=true — 충돌 감수 명시 시 전체 커밋 + 감수한 충돌 목록 반환
    const forced = await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ startTime: '11:00', endTime: '12:00', topic: '충돌시리즈', force: true })).expect(201);
    expect((forced.body.conflicts as unknown[]).length).toBeGreaterThan(0);
    expect((forced.body.rows as unknown[]).length).toBe(2);
  });

  it.each([['첫', 1], ['중간', 2], ['마지막', 3]])('%s occurrence insert 실패 주입 — series +0, sessions +0, audit +0', async (_label, failAt) => {
    const store = app.get(ClassSessionsStore);
    const original = store.insert.bind(store);
    let calls = 0;
    const spy = jest.spyOn(store, 'insert').mockImplementation(async (data) => {
      calls += 1;
      if (calls === failAt) throw new Error(`injected occurrence insert failure #${failAt}`);
      return original(data);
    });
    const before = { series: seriesRows().length, sessionAudit: auditCount('class_sessions', 'create'), seriesAudit: auditCount(CLASS_SESSION_SERIES, 'create') };
    await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ repeat: { kind: 'custom', weekdays: [2, 4, 6], startsOn: '2099-07-06', endsOn: '2099-07-11' }, startTime: '13:00', endTime: '14:00', topic: `실패주입${failAt}` }))
      .expect(500);
    spy.mockRestore();
    expect(seriesRows().length).toBe(before.series);
    expect((await sessionsBetween('2099-07-06', '2099-07-11')).filter((r) => r.topic === `실패주입${failAt}`)).toHaveLength(0);
    expect(auditCount('class_sessions', 'create')).toBe(before.sessionAudit);
    expect(auditCount(CLASS_SESSION_SERIES, 'create')).toBe(before.seriesAudit);
  });

  it('audit 실패 주입(series audit) — 전부 롤백 후 재시도 정상', async () => {
    const audit = app.get(AuditService);
    const before = { series: seriesRows().length };
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected series audit failure'));
    await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ startTime: '15:00', endTime: '16:00', topic: '감사실패' })).expect(500);
    spy.mockRestore();
    expect(seriesRows().length).toBe(before.series);
    expect((await sessionsBetween(STARTS, ENDS)).filter((r) => r.topic === '감사실패')).toHaveLength(0);
    const retry = await http.post('/api/schedule/series').set(asAdmin())
      .send(cmd({ startTime: '15:00', endTime: '16:00', topic: '감사실패' })).expect(201);
    expect((retry.body.rows as unknown[]).length).toBe(2);
  });

  it('동시 동일 슬롯 시리즈 2건 — 성공 1 · 409 1(직렬화), 회차 이중 저장 0', async () => {
    const body = cmd({ startTime: '17:00', endTime: '18:00', topic: '동시시리즈' });
    const [a, b] = await Promise.all([
      http.post('/api/schedule/series').set(asAdmin()).send(body),
      http.post('/api/schedule/series').set(asAdmin()).send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const saved = (await sessionsBetween(STARTS, ENDS)).filter((r) => r.topic === '동시시리즈');
    expect(saved).toHaveLength(2); // 승자 1건의 2회차만
  });

  it('강사 토큰 → 403(직접 배정 불가 — 승인 요청 흐름)', async () => {
    await http.post('/api/schedule/series').set(asInst()).send(cmd()).expect(403);
  });

  it('단건 create의 유령 seriesId → 400(서버 발급 자산만 허용)', async () => {
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-07-08', startTime: '20:00', endTime: '21:00', seriesId: 999999, topic: '유령시리즈' })
      .expect(400);
  });
});
