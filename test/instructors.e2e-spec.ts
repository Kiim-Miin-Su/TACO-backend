import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { createTestApp, sudoAuthHeaders } from './setup-app';

describe('Instructor aggregate CRUD (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  // [TBO-79 C1] /instructors 변경 명령은 /users 쌍둥이와 같이 sudo(재인증) 쿠키를 요구한다.
  const sudo = (role: string) => sudoAuthHeaders(app, tokens[role]);

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
        .toMatchObject({ id: 1, defaultHourlyRate: 50000, canTeachKinder: false });
    }
    await http.get('/api/instructors').set(as('instructor')).expect(403);
  });

  it.each(['manager', 'admin'])('%s는 비재무 강사 C/U/D를 sudo로 수행하고 감사 이력을 남긴다', async (role) => {
    const webId = `inst_${role}_${Date.now().toString(36)}`;
    const endpoint = role === 'manager' ? '/api/users/instructors' : '/api/instructors';
    await http.post(endpoint).set(as(role)).send({ webId, name: 'sudo 없음', password: 'password123' })
      .expect(403).expect(({ body }) => expect(body.code).toBe('SUDO_REQUIRED'));
    await http.post(endpoint).set(sudo(role)).send({
      webId, name: '시급 우회', password: 'password123', defaultHourlyRate: 55000,
    }).expect(403);

    const created = (await http.post(endpoint).set(sudo(role)).send({
      webId, name: `${role} 등록 강사`, password: 'password123', phone: '010-5555-0000',
      university: 'TACO University', major: 'Education', birthYear: 1992,
      canTeachKinder: true,
    }).expect(201)).body;
    const id = Number(created.id);
    expect(id).toBeGreaterThan(0);

    await http.patch(`/api/instructors/${id}`).set(sudo(role)).send({ defaultHourlyRate: 60000 }).expect(403);
    const updated = (await http.patch(`/api/instructors/${id}`).set(sudo(role)).send({
      name: `${role} 수정 강사`, canTeachKinder: false,
    }).expect(200)).body;
    expect(updated).toMatchObject({ name: `${role} 수정 강사`, defaultHourlyRate: 0, canTeachKinder: false });

    const audit = app.get(AuditService);
    const profileAudit = await audit.list({ entity: 'instructor_profiles', entityId: id });
    expect(profileAudit.map((row) => row.action)).toEqual(expect.arrayContaining(['create', 'update']));
    expect(JSON.stringify(profileAudit)).not.toContain('1992');
    expect(JSON.stringify(profileAudit)).toContain('[masked]');

    await http.delete(`/api/instructors/${id}`).set(sudo(role)).expect(200);
    await http.get(`/api/instructors/${id}`).set(as('super')).expect(404);
    expect((await audit.list({ entity: 'instructor_profiles', entityId: id }))
      .some((row) => row.action === 'delete')).toBe(true);
  });

  it('대표는 기본 시급을 포함해 강사를 관리하고 강사는 직접 원부를 생성하지 못한다', async () => {
    const webId = `inst_pay_${Date.now().toString(36)}`;
    await http.post('/api/instructors').set(sudo('instructor'))
      .send({ webId, name: '강사 우회', password: 'password123' }).expect(403);
    const created = (await http.post('/api/instructors').set(sudo('super')).send({
      webId, name: '시급 관리 강사', password: 'password123', defaultHourlyRate: 55000,
    }).expect(201)).body;
    expect(created).toMatchObject({ defaultHourlyRate: 55000 });
    await http.patch(`/api/instructors/${created.id}`).set(sudo('super'))
      .send({ defaultHourlyRate: 60000 }).expect(200)
      .expect(({ body }) => expect(body.defaultHourlyRate).toBe(60000));
    await http.delete(`/api/instructors/${created.id}`).set(sudo('manager')).expect(200);
  });

  it('활성 수업·스케줄·계약이 있는 강사는 삭제 409로 보호한다', async () => {
    await http.delete('/api/instructors/1').set(sudo('manager')).expect(409);
  });
});
