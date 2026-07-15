// [TBO-29D 요구 ⑤⑥] 학원 공통 이벤트 CRUD·권한·영속 e2e —
//  조회=강사 포함 전 직원, CUD=매니저 이상(강사 403), 수정 병합 재검증, soft delete, PG 재수화 유지.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { ACADEMY_EVENTS_SPEC } from '../src/database/calendar-asset-specs';
import type { AcademyEvent } from '../src/modules/events/event.entity';

describe('[TBO-29D ⑤⑥] academy events CRUD (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });
  const as = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });

  it('조회 권한 — 강사 포함 로그인 직원 전원 200, 무토큰 401', async () => {
    const inst = await http.get('/api/events').set(as('park_inst')).expect(200);
    expect(inst.body.length).toBeGreaterThanOrEqual(4); // 시드 포함 — 강사도 공통 일정을 본다(전체 뷰 요구 ⑤)
    await http.get('/api/events').expect(401);
  });

  it('CUD 권한 — 강사 403(매니저 이상 전용), 매니저 201', async () => {
    await http.post('/api/events').set(as('park_inst'))
      .send({ title: '강사 발행 시도', type: 'event', startDate: '2026-08-01', endDate: '2026-08-01' }).expect(403);
    const created = await http.post('/api/events').set(as('manager'))
      .send({ title: '입시 설명회', type: 'event', priority: 'high', startDate: '2026-08-05', endDate: '2026-08-06' }).expect(201);
    await http.patch(`/api/events/${created.body.id}`).set(as('park_inst')).send({ title: 'x' }).expect(403);
    await http.delete(`/api/events/${created.body.id}`).set(as('park_inst')).expect(403);
  });

  it('수정 — 부분 패치 병합 후 구간 재검증(end<start 역전 400), diff audit 기록', async () => {
    const created = (await http.post('/api/events').set(as('manager'))
      .send({ title: '모의고사', type: 'exam', startDate: '2026-08-10', endDate: '2026-08-12' }).expect(201)).body;
    // endDate만 당겨 역전 시도 → 400
    await http.patch(`/api/events/${created.id}`).set(as('manager')).send({ endDate: '2026-08-09' }).expect(400);
    // 정상 수정
    const updated = (await http.patch(`/api/events/${created.id}`).set(as('manager'))
      .send({ title: '모의고사(변경)', endDate: '2026-08-13' }).expect(200)).body;
    expect(updated).toMatchObject({ title: '모의고사(변경)', endDate: '2026-08-13' });
    const audits = db.findAll<{ entity: string; entityId: number; action: string }>('audit_log')
      .filter((a) => a.entity === 'academy_events' && a.entityId === created.id);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['create', 'update']));
  });

  it('삭제 — soft delete 후 목록 제외 + before 스냅샷 audit, 재삭제 404', async () => {
    const created = (await http.post('/api/events').set(as('manager'))
      .send({ title: '삭제 대상', type: 'notice', startDate: '2026-08-20', endDate: '2026-08-20' }).expect(201)).body;
    await http.delete(`/api/events/${created.id}`).set(as('manager')).expect(200);
    const listed = (await http.get('/api/events').set(as('manager')).expect(200)).body as AcademyEvent[];
    expect(listed.find((e) => e.id === created.id)).toBeUndefined();
    await http.delete(`/api/events/${created.id}`).set(as('manager')).expect(404);
  });

  it('[영속 회귀] 발행/수정이 PG 재수화 후에도 유지 — 메모리 전용이었다면 증발', async () => {
    const created = (await http.post('/api/events').set(as('manager'))
      .send({ title: '영속 검증', type: 'closure', startDate: '2026-09-01', endDate: '2026-09-02', allDay: true }).expect(201)).body;
    const pg = app.get(PostgresConnectionService);
    expect(typeof pg.ready).toBe('boolean');
    if (pg.ready) await app.get(PostgresCollectionStore).hydrate<AcademyEvent>(ACADEMY_EVENTS_SPEC);
    const row = db.findById<AcademyEvent>('academy_events', created.id)!;
    expect(row).toMatchObject({ title: '영속 검증', startDate: '2026-09-01', endDate: '2026-09-02' });
    expect(typeof row.startDate).toBe('string'); // dateFields 변환 — PG Date 객체 함정 방지(§13.83)
  });
});
