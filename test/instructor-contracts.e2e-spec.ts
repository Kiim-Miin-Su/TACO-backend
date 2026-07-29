import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

// [TBO-19 Sprint4 → TBO-74C] 강사 계약 조회 — 시급 포함이라 대표 전용, 시드 2건.
describe('Instructor contracts (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
  });
  afterAll(async () => {
    await app.close();
  });

  const token = async (webId: string) =>
    (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;

  it('대표: 계약 목록 2건(강사1·2)', async () => {
    const admin = await token('admin');
    const list = (await http.get('/api/instructor-contracts').set({ Authorization: `Bearer ${admin}` }).expect(200)).body;
    expect(list.length).toBe(2);
    const c1 = list.find((c: { instructorId: number }) => c.instructorId === 1);
    expect(c1).toMatchObject({ monthlyHours: 40, hourlyRate: 50000, active: true });
    await http
      .get('/api/instructor-contracts')
      .query({ instructorId: 1 })
      .set({ Authorization: `Bearer ${admin}` })
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(1));
  });

  it('관리자·강사: 계약 조회 차단(403 — 시급 민감)', async () => {
    const manager = await token('manager');
    const inst = await token('park_inst');
    await http.get('/api/instructor-contracts').set({ Authorization: `Bearer ${manager}` }).expect(403);
    await http.get('/api/instructor-contracts').set({ Authorization: `Bearer ${inst}` }).expect(403);
  });

  it('대표 재인증: 기존 계약 종료 후 신규 계약 생성·수정·중복 방지·감사 이력을 영속화한다', async () => {
    const admin = await token('admin');
    const auth = sudoAuthHeaders(app, admin);

    await http
      .patch('/api/instructor-contracts/1')
      .set(auth)
      .send({ periodEnd: '2098-12-31', reason: '신규 계약 전 기존 계약 종료일 확정' })
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ id: 1, periodEnd: '2098-12-31' }));

    const created = (
      await http
        .post('/api/instructor-contracts')
        .set(auth)
        .send({
          instructorId: 1,
          monthlyHours: 44,
          hourlyRate: 55_000,
          periodStart: '2099-01-01',
          memo: '2099 신규 계약',
        })
        .expect(201)
    ).body;

    expect(created).toMatchObject({
      instructorId: 1,
      monthlyHours: 44,
      hourlyRate: 55_000,
      periodStart: '2099-01-01',
      active: true,
    });

    await http
      .post('/api/instructor-contracts')
      .set(auth)
      .send({
        instructorId: 1,
        monthlyHours: 20,
        hourlyRate: 40_000,
        periodStart: '2099-06-01',
      })
      .expect(409);

    const updated = (
      await http
        .patch(`/api/instructor-contracts/${created.id}`)
        .set(auth)
        .send({ monthlyHours: 48, hourlyRate: 58_000, memo: '협의 완료', reason: '연간 계약 조건 조정' })
        .expect(200)
    ).body;
    expect(updated).toMatchObject({ monthlyHours: 48, hourlyRate: 58_000, memo: '협의 완료' });

    const readback = (
      await http.get(`/api/instructor-contracts/${created.id}`).set({ Authorization: `Bearer ${admin}` }).expect(200)
    ).body;
    expect(readback).toMatchObject({ id: created.id, monthlyHours: 48, hourlyRate: 58_000 });

    const auditRows = db
      .findAll<{ entity: string; entityId: number; action: string; reason?: string } & { id: number }>('audit_log')
      .filter((row) => row.entity === 'instructor_contracts' && row.entityId === created.id);
    expect(auditRows.map((row) => row.action)).toEqual(expect.arrayContaining(['create', 'update']));
    expect(auditRows.find((row) => row.action === 'update')?.reason).toBe('연간 계약 조건 조정');
  });

  it('계약 쓰기 방어: sudo·활성 강사·기간·DTO allowlist를 강제한다', async () => {
    const admin = await token('admin');
    const manager = await token('manager');
    const body = {
      instructorId: 1,
      monthlyHours: 20,
      hourlyRate: 40_000,
      periodStart: '2101-01-01',
    };

    await http.post('/api/instructor-contracts').set({ Authorization: `Bearer ${admin}` }).send(body).expect(403);
    await http.post('/api/instructor-contracts').set(sudoAuthHeaders(app, manager)).send(body).expect(403);
    await http
      .post('/api/instructor-contracts')
      .set(sudoAuthHeaders(app, admin))
      .send({ ...body, instructorId: 999_999 })
      .expect(400);
    await http
      .post('/api/instructor-contracts')
      .set(sudoAuthHeaders(app, admin))
      .send({ ...body, periodEnd: '2100-01-01' })
      .expect(400);
    await http
      .post('/api/instructor-contracts')
      .set(sudoAuthHeaders(app, admin))
      .send({ ...body, serverOwned: true })
      .expect(400);
    await http
      .patch('/api/instructor-contracts/1')
      .set(sudoAuthHeaders(app, admin))
      .send({ active: false, periodEnd: null, reason: '종료일 없는 종료 방어' })
      .expect(400);
  });
});
