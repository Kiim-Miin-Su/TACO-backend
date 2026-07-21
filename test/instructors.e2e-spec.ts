import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { createTestApp } from './setup-app';

describe('Instructor aggregate CRUD (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const [role, webId] of Object.entries({ super: 'admin', manager: 'manager', admin: 'prof_admin', instructor: 'park_inst' })) {
      tokens[role] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });

  afterAll(async () => { await app.close(); });

  it('관리자 이상은 목록·상세를 읽고 강사는 403이다', async () => {
    for (const role of ['super', 'manager', 'admin']) {
      const list = (await http.get('/api/instructors').set(as(role)).expect(200)).body;
      expect(list.some((row: { id: number }) => row.id === 1)).toBe(true);
      expect((await http.get('/api/instructors/1').set(as(role)).expect(200)).body)
        .toMatchObject({ id: 1, defaultHourlyRate: 0, canTeachKinder: false });
    }
    await http.get('/api/instructors').set(as('instructor')).expect(403);
  });

  it('대표만 생성·수정·삭제하고 profile 변경·삭제 이력을 남긴다', async () => {
    const webId = `inst_${Date.now().toString(36)}`;
    await http.post('/api/instructors').set(as('manager')).send({ webId, name: '차단', password: 'password123' }).expect(403);
    const created = (await http.post('/api/instructors').set(as('super')).send({
      webId, name: '신규 강사', password: 'password123', phone: '010-5555-0000',
      university: 'TACO University', major: 'Education', birthYear: 1992,
      defaultHourlyRate: 55000, canTeachKinder: true,
    }).expect(201)).body;
    expect(created).toMatchObject({ webId, name: '신규 강사', defaultHourlyRate: 55000, canTeachKinder: true });

    await http.patch(`/api/instructors/${created.id}`).set(as('admin')).send({ defaultHourlyRate: 60000 }).expect(403);
    const updated = (await http.patch(`/api/instructors/${created.id}`).set(as('super')).send({
      name: '수정 강사', defaultHourlyRate: 60000, canTeachKinder: false,
    }).expect(200)).body;
    expect(updated).toMatchObject({ name: '수정 강사', defaultHourlyRate: 60000, canTeachKinder: false });

    const audit = app.get(AuditService);
    const profileAudit = await audit.list({ entity: 'instructor_profiles', entityId: created.id });
    expect(profileAudit.map((row) => row.action)).toEqual(expect.arrayContaining(['create', 'update']));
    expect(JSON.stringify(profileAudit)).not.toContain('1992');
    expect(JSON.stringify(profileAudit)).toContain('[masked]');

    await http.delete(`/api/instructors/${created.id}`).set(as('manager')).expect(403);
    await http.delete(`/api/instructors/${created.id}`).set(as('super')).expect(200);
    await http.get(`/api/instructors/${created.id}`).set(as('super')).expect(404);
    expect((await audit.list({ entity: 'instructor_profiles', entityId: created.id }))
      .some((row) => row.action === 'delete')).toBe(true);
  });

  it('활성 수업·스케줄·계약이 있는 강사는 삭제 409로 보호한다', async () => {
    await http.delete('/api/instructors/1').set(as('super')).expect(409);
  });
});
