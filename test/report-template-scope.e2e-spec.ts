import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { createTestApp } from './setup-app';

describe('[TBO-86 G3b] report template scope and effective priority (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['manager', 'park_inst', 'jung_inst']) {
      const login = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' }).expect(201)).body;
      tokens[webId] = login.accessToken;
      ids[webId] = login.account.id;
    }
  });

  afterAll(async () => { await app.close(); });

  it('instructor creates only personal templates and cannot target another instructor/global enforced', async () => {
    const personal = (await http.post('/api/report-templates').set(auth('park_inst')).send({
      name: 'Park 개인 기본',
      content: '개인 수업 내용',
      progressPage: '개인 진도',
      homework: '개인 숙제',
      isDefault: true,
    }).expect(201)).body;
    expect(personal).toMatchObject({
      ownerUserId: ids.park_inst,
      isDefault: true,
      isEnforced: false,
      progressPage: '개인 진도',
    });

    await http.post('/api/report-templates').set(auth('park_inst')).send({
      name: '타인 개인', content: '차단', ownerUserId: ids.jung_inst,
    }).expect(403);
    await http.post('/api/report-templates').set(auth('park_inst')).send({
      name: '강사 전역 강제', content: '차단', isEnforced: true,
    }).expect(403);
    await http.get('/api/report-templates/effective')
      .query({ instructorId: ids.jung_inst }).set(auth('park_inst')).expect(403);

    const parkList = (await http.get('/api/report-templates').set(auth('park_inst')).expect(200)).body;
    expect(parkList.some((row: { id: number }) => row.id === personal.id)).toBe(true);
    const jungList = (await http.get('/api/report-templates').set(auth('jung_inst')).expect(200)).body;
    expect(jungList.some((row: { id: number }) => row.id === personal.id)).toBe(false);
    expect((await http.get('/api/report-templates/effective')
      .set(auth('park_inst')).expect(200)).body).toMatchObject({ id: personal.id });
  });

  it('manager global enforced overrides personal default and only manager can mutate it', async () => {
    const enforced = (await http.post('/api/report-templates').set(auth('manager')).send({
      name: 'Grace 전역 강제',
      content: '학생/학년\n수업일자 / 과목 / 시간\n수업 내용',
      progressPage: '진도페이지',
      homework: '숙제',
      ownerUserId: null,
      isEnforced: true,
    }).expect(201)).body;
    expect(enforced).toMatchObject({ ownerUserId: null, isEnforced: true });
    expect((await http.get('/api/report-templates/effective')
      .set(auth('park_inst')).expect(200)).body).toMatchObject({ id: enforced.id });
    await http.patch(`/api/report-templates/${enforced.id}`).set(auth('park_inst')).send({
      name: enforced.name, content: '침범', isEnforced: false,
    }).expect(403);
    await http.delete(`/api/report-templates/${enforced.id}`).set(auth('park_inst')).expect(403);

    await http.patch(`/api/report-templates/${enforced.id}`).set(auth('manager')).send({
      name: enforced.name,
      content: enforced.content,
      progressPage: enforced.progressPage,
      homework: enforced.homework,
      ownerUserId: null,
      isDefault: false,
      isEnforced: false,
    }).expect(200);
    expect((await http.get('/api/report-templates/effective')
      .set(auth('park_inst')).expect(200)).body).toMatchObject({ name: 'Park 개인 기본' });
  });

  it('same name is scoped, default transitions leave exactly one winner, and audit failure rolls back', async () => {
    const sharedName = 'Scope 이름 재사용';
    await http.post('/api/report-templates').set(auth('manager')).send({
      name: sharedName, content: '전역', ownerUserId: null,
    }).expect(201);
    await http.post('/api/report-templates').set(auth('park_inst')).send({
      name: sharedName, content: '개인',
    }).expect(201);
    await http.post('/api/report-templates').set(auth('park_inst')).send({
      name: sharedName, content: '개인 중복',
    }).expect(400);

    const results = await Promise.all([
      http.post('/api/report-templates').set(auth('manager')).send({
        name: 'Park 기본 교체 A', content: 'A', ownerUserId: ids.park_inst, isDefault: true,
      }),
      http.post('/api/report-templates').set(auth('manager')).send({
        name: 'Park 기본 교체 B', content: 'B', ownerUserId: ids.park_inst, isDefault: true,
      }),
    ]);
    expect(results.map((result) => result.status)).toEqual([201, 201]);
    const beforeFailure = (await http.get('/api/report-templates').set(auth('manager')).expect(200)).body;
    const defaults = beforeFailure.filter((row: { ownerUserId?: number; isDefault: boolean }) =>
      row.ownerUserId === ids.park_inst && row.isDefault,
    );
    expect(defaults).toHaveLength(1);

    const auditSpy = jest.spyOn(app.get(AuditService), 'log')
      .mockRejectedValueOnce(new Error('injected template scope audit failure'));
    await http.post('/api/report-templates').set(auth('manager')).send({
      name: '롤백 기본값', content: '남으면 안 됨', ownerUserId: ids.park_inst, isDefault: true,
    }).expect(500);
    auditSpy.mockRestore();

    const afterFailure = (await http.get('/api/report-templates').set(auth('manager')).expect(200)).body;
    expect(afterFailure.some((row: { name: string }) => row.name === '롤백 기본값')).toBe(false);
    expect(afterFailure.filter((row: { ownerUserId?: number; isDefault: boolean }) =>
      row.ownerUserId === ids.park_inst && row.isDefault,
    )).toEqual(expect.arrayContaining([expect.objectContaining({ id: defaults[0].id })]));
  });

  it('manager may target an active instructor but rejects non-instructor owners', async () => {
    const targeted = (await http.post('/api/report-templates').set(auth('manager')).send({
      name: 'Jung 개인 기본', content: 'Jung 전용', ownerUserId: ids.jung_inst, isDefault: true,
    }).expect(201)).body;
    expect((await http.get('/api/report-templates/effective')
      .query({ instructorId: ids.jung_inst }).set(auth('manager')).expect(200)).body)
      .toMatchObject({ id: targeted.id });
    await http.post('/api/report-templates').set(auth('manager')).send({
      name: '비강사 대상', content: '차단', ownerUserId: ids.manager,
    }).expect(400);
  });
});
