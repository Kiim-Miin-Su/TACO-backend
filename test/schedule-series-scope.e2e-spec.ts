// [TBO-29C C3] 반복 수정·삭제·승인 원자성 e2e — series lock/CAS/회차별 audit/scoped delete.
//  in-memory(CI 상시) + DATABASE_URL 재실행(PG advisory lock) 이중 모드.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AuditService } from '../src/modules/audit/audit.service';
import { CLASS_SESSION_SERIES } from '../src/modules/schedule/schedule-series.entity';
import { selectSeriesScope } from '../src/modules/schedule/series-scope.policy';
import { ClassSession, SESSIONS } from '../src/modules/schedule/schedule.entity';

describe('[TBO-29C C3] series scope update/delete/approval atomicity', () => {
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

  const mkSeries = async (startsOn: string, endsOn: string, weekdays: number[], startTime: string, topic: string) =>
    (await http.post('/api/schedule/series').set(asAdmin())
      .send({ courseId: 10, instructorId: 1, repeat: { kind: weekdays.length === 1 ? 'weekly' : 'custom', weekdays, startsOn, endsOn }, startTime, durationMinutes: 60, topic })
      .expect(201)).body as { series: { id: number; version: number }; rows: Array<{ id: number; sessionDate: string; seriesId: number; seriesVersion?: number }> };

  const auditsFor = (entity: string, entityId: number) =>
    db.findAll<{ entity: string; entityId: number; action: string; reason?: string; changes?: Record<string, unknown> }>('audit_log')
      .filter((x) => x.entity === entity && x.entityId === entityId);

  it('scope 순수 함수 — 같은 날짜의 늦은 회차도 this_and_following에 포함(경계), all은 전원', () => {
    const members = [
      { id: 1, sessionDate: '2099-09-01', startTime: '09:00' },
      { id: 2, sessionDate: '2099-09-01', startTime: '11:00' }, // 같은 날짜, 늦은 시간
      { id: 3, sessionDate: '2099-09-03', startTime: '09:00' },
      { id: 4, sessionDate: '2099-08-30', startTime: '09:00' },
    ];
    const pivot = members[0];
    expect(selectSeriesScope(members, pivot, 'this')).toEqual([]);
    expect(selectSeriesScope(members, pivot, 'this_and_following').map((m) => m.id)).toEqual([2, 3]);
    expect(selectSeriesScope(members, pivot, 'all').map((m) => m.id)).toEqual([4, 2, 3]);
    // 같은 날짜·시간이면 id로 결정적 판정
    const tie = [{ id: 5, sessionDate: '2099-09-01', startTime: '09:00' }];
    expect(selectSeriesScope([...members, ...tie], pivot, 'this_and_following').map((m) => m.id)).toEqual([5, 2, 3]);
  });

  it('this_and_following 수정 — 바뀐 모든 회차에 개별 audit + 공통 correlation + seriesVersion 전진', async () => {
    const made = await mkSeries('2099-09-07', '2099-09-21', [1], '09:00', 'C3수정');
    const [r1, r2, r3] = made.rows;
    expect(made.rows.every((r) => r.seriesVersion === 1)).toBe(true);
    const res = await http.patch(`/api/schedule/${r2.id}`).set(asAdmin())
      .send({ startTime: '10:00', durationMinutes: 60, scope: 'this_and_following', expectedSeriesVersion: 1 })
      .expect(200);
    expect(res.body.updated).toBe(2); // r2 + r3
    // 회차별 audit before/after + 같은 correlation
    const a2 = auditsFor(SESSIONS, r2.id).filter((x) => x.action === 'update');
    const a3 = auditsFor(SESSIONS, r3.id).filter((x) => x.action === 'update');
    expect(a2).toHaveLength(1);
    expect(a3).toHaveLength(1);
    expect(a2[0].reason).toBeDefined();
    expect(a2[0].reason).toBe(a3[0].reason); // 공통 correlation
    expect(String(a2[0].reason)).toContain(`series=${made.series.id}`);
    expect(String(a2[0].reason)).toContain('scope=this_and_following');
    // r1은 불변(audit 없음), series version 2로 전진 + series audit
    expect(auditsFor(SESSIONS, r1.id).filter((x) => x.action === 'update')).toHaveLength(0);
    const series = db.findAll<{ id: number; version: number }>(CLASS_SESSION_SERIES).find((x) => x.id === made.series.id);
    expect(series?.version).toBe(2);
    expect(auditsFor(CLASS_SESSION_SERIES, made.series.id).filter((x) => x.action === 'update')).toHaveLength(1);
    // 갱신된 seriesVersion이 rows에 회신
    const rows = (await http.get('/api/schedule?from=2099-09-07&to=2099-09-21').set(asAdmin()).expect(200)).body as Array<{ id: number; seriesVersion?: number }>;
    expect(rows.find((r) => r.id === r1.id)?.seriesVersion).toBe(2);
  });

  it('series version CAS — 동시에 제출된 서로 다른 회차 scope 변경은 성공 1 · 409(SERIES_VERSION_STALE) 1, 부분 회차 0', async () => {
    const made = await mkSeries('2099-10-05', '2099-10-19', [1], '09:00', 'C3CAS');
    const [r1, r2] = made.rows;
    const [a, b] = await Promise.all([
      http.patch(`/api/schedule/${r1.id}`).set(asAdmin()).send({ startTime: '10:00', scope: 'all', expectedSeriesVersion: 1 }),
      http.patch(`/api/schedule/${r2.id}`).set(asAdmin()).send({ startTime: '11:00', scope: 'all', expectedSeriesVersion: 1 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.code).toBe('SERIES_VERSION_STALE');
    expect(loser.body.currentVersion).toBe(2);
    // 부분 회차 0 — 모든 회차가 승자 시각으로 동일
    const winnerTime = (a.status === 200 ? '10:00' : '11:00');
    const rows = (await http.get('/api/schedule?from=2099-10-05&to=2099-10-19').set(asAdmin()).expect(200)).body as Array<{ seriesId?: number; startTime?: string }>;
    const members = rows.filter((r) => r.seriesId === made.series.id);
    expect(members).toHaveLength(3);
    expect(members.every((m) => m.startTime === winnerTime)).toBe(true);
  });

  it('scoped delete(this_and_following) — 이후 회차만 삭제·회차별 audit·series endsOn 축소·version 전진', async () => {
    const made = await mkSeries('2099-11-02', '2099-11-16', [1], '09:00', 'C3삭제');
    const [r1, r2, r3] = made.rows;
    const res = await http.delete(`/api/schedule/${r2.id}?scope=this_and_following&expectedSeriesVersion=1`).set(asAdmin()).expect(200);
    expect(res.body.removedIds.sort()).toEqual([r2.id, r3.id].sort());
    const rows = (await http.get('/api/schedule?from=2099-11-02&to=2099-11-16').set(asAdmin()).expect(200)).body as Array<{ id: number }>;
    expect(rows.some((r) => r.id === r1.id)).toBe(true);
    expect(rows.some((r) => r.id === r2.id || r.id === r3.id)).toBe(false);
    const d2 = auditsFor(SESSIONS, r2.id).filter((x) => x.action === 'delete');
    const d3 = auditsFor(SESSIONS, r3.id).filter((x) => x.action === 'delete');
    expect(d2).toHaveLength(1);
    expect(d3).toHaveLength(1);
    expect(d2[0].reason).toBe(d3[0].reason);
    const series = db.findAll<{ id: number; version: number; endsOn: string }>(CLASS_SESSION_SERIES).find((x) => x.id === made.series.id);
    expect(series?.version).toBe(2);
    expect(series?.endsOn).toBe(r1.sessionDate); // 남은 마지막 회차로 축소
    // stale CAS 삭제는 409
    const stale = await http.delete(`/api/schedule/${r1.id}?scope=all&expectedSeriesVersion=1`).set(asAdmin()).expect(409);
    expect(stale.body.code).toBe('SERIES_VERSION_STALE');
    // scope=all 전량 삭제 → series soft delete
    await http.delete(`/api/schedule/${r1.id}?scope=all&expectedSeriesVersion=2`).set(asAdmin()).expect(200);
    expect(db.findAll<{ id: number }>(CLASS_SESSION_SERIES).some((x) => x.id === made.series.id)).toBe(false);
    expect(auditsFor(CLASS_SESSION_SERIES, made.series.id).filter((x) => x.action === 'delete')).toHaveLength(1);
  });

  it('scoped delete 사전 검증 — 동반 회차 하나가 정산 연결이면 전체 불변(부분 삭제 0)', async () => {
    const made = await mkSeries('2099-12-07', '2099-12-21', [1], '09:00', 'C3정산잠금');
    const [r1, r2] = made.rows;
    // 정산 연결은 API 흐름 대신 스토어 write-through로 재현(두 모드 동일) — payouts 흐름은 payout e2e가 소유
    const { ClassSessionsStore } = await import('../src/modules/schedule/class-sessions.store');
    const store = app.get(ClassSessionsStore);
    await store.update(r2.id, { payoutId: 990001, instructorPayAmount: 10000 } as never);
    const res = await http.delete(`/api/schedule/${r1.id}?scope=all`).set(asAdmin()).expect(409);
    expect(res.body.code).toBe('PAYOUT_REVERSAL_REQUIRED');
    expect(res.body.sessionIds).toEqual([r2.id]);
    const rows = (await http.get('/api/schedule?from=2099-12-07&to=2099-12-21').set(asAdmin()).expect(200)).body as Array<{ id: number }>;
    expect(rows.some((r) => r.id === r1.id)).toBe(true); // 아무것도 삭제되지 않음
    expect(rows.some((r) => r.id === r2.id)).toBe(true);
    // 정리 — 정산 해제 후 삭제(다음 테스트 오염 방지)
    await store.update(r2.id, { payoutId: null, instructorPayAmount: null } as never);
    await http.delete(`/api/schedule/${r1.id}?scope=all`).set(asAdmin()).expect(200);
  });

  it('강사 시리즈 변경 요청 승인 중 실패 주입 — request pending 유지, 회차 변화 +0', async () => {
    const made = await mkSeries('2100-01-04', '2100-01-18', [1], '09:00', 'C3승인');
    const [r1] = made.rows;
    const req = (await http.post('/api/schedule-requests').set(asInst())
      .send({ requestKind: 'session_update', targetSessionId: r1.id, sessionDate: r1.sessionDate, startTime: '10:00', endTime: '11:00', scope: 'this_and_following', requestReason: '시작 시간을 1시간 늦춥니다.' })
      .expect(201)).body.row;
    const audit = app.get(AuditService);
    // 승인 경로의 series 편집 audit에서 실패 주입 → 세션/시리즈/요청 모두 원상
    const spy = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected approval audit failure'));
    await http.post(`/api/schedule-requests/${req.id}/approve?force=true`).set(asAdmin()).expect(500);
    spy.mockRestore();
    const pending = (await http.get('/api/schedule-requests?status=pending').set(asAdmin()).expect(200)).body as Array<{ id: number }>;
    expect(pending.some((r) => r.id === req.id)).toBe(true); // pending 유지
    const rows = (await http.get('/api/schedule?from=2100-01-04&to=2100-01-18').set(asAdmin()).expect(200)).body as Array<{ seriesId?: number; startTime?: string }>;
    expect(rows.filter((r) => r.seriesId === made.series.id).every((r) => r.startTime === '09:00')).toBe(true); // 회차 변화 +0
    // 재승인은 정상 — direct와 같은 series UoW(회차 전체 반영 + version 전진)
    await http.post(`/api/schedule-requests/${req.id}/approve?force=true`).set(asAdmin()).expect(201);
    const after = (await http.get('/api/schedule?from=2100-01-04&to=2100-01-18').set(asAdmin()).expect(200)).body as Array<{ seriesId?: number; startTime?: string; seriesVersion?: number }>;
    const members = after.filter((r) => r.seriesId === made.series.id);
    expect(members.every((m) => m.startTime === '10:00')).toBe(true);
    expect(members[0]?.seriesVersion).toBe(2);
  });

  it('시리즈 member 단건(scope=this) 편집도 series lock 공간을 지나며 CAS는 강제하지 않는다', async () => {
    const made = await mkSeries('2100-02-01', '2100-02-15', [1], '09:00', 'C3단건');
    const [r1, r2] = made.rows;
    await http.patch(`/api/schedule/${r1.id}`).set(asAdmin()).send({ startTime: '14:00', scope: 'this' }).expect(200);
    const rows = (await http.get('/api/schedule?from=2100-02-01&to=2100-02-15').set(asAdmin()).expect(200)).body as Array<{ id: number; startTime?: string; seriesVersion?: number }>;
    expect(rows.find((r) => r.id === r1.id)?.startTime).toBe('14:00');
    expect(rows.find((r) => r.id === r2.id)?.startTime).toBe('09:00');
    expect(rows.find((r) => r.id === r2.id)?.seriesVersion).toBe(1); // 단건 편집은 규칙 불변 — version 유지
  });
});
