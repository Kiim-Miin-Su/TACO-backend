// [유저 관리 2026-07-20 대표 지시] 유저 탭 CRUD e2e — 재인증 게이트·상세 단건·대표 직접 수정·
//  직접 등록 역할 확장. 규약: 대상 super_admin 수정 400(단일 불변식)·role/email 변경=대상 세션
//  전멸(auth_version+1)·rrnMasked는 super_admin 응답에만·email 원문은 audit에 미기록.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { verifiedSignupChallenge } from './signup-helper';
import { InstructorProfilesStore } from '../src/modules/users/instructor-profiles.store';
import { AuditService } from '../src/modules/audit/audit.service';

jest.retryTimes(0);

describe('Users admin CRUD + reauth (e2e, 유저 관리 2026-07-20)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let manager = '';
  let inst = '';
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const sudoAdmin = () => sudoAuthHeaders(app, admin);
  const login = async (webId: string, password = 'demo1234') =>
    (await http.post('/api/auth/login').send({ webId, password }).expect(201)).body.accessToken as string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = await login('admin');
    manager = await login('manager');
    inst = await login('park_inst');
  });
  afterAll(async () => { await app.close(); });

  it('① reauth: 정답 201 {ok} · 오답 400(일반화 문구) · 강사도 본인 비밀번호로 가능', async () => {
    expect((await http.post('/api/auth/reauth').set(auth(admin)).send({ currentPassword: 'demo1234' }).expect(201)).body).toEqual({ ok: true });
    await http.post('/api/auth/reauth').set(auth(admin)).send({ currentPassword: 'wrong-pass' }).expect(400);
    await http.post('/api/auth/reauth').set(auth(inst)).send({ currentPassword: 'demo1234' }).expect(201);
  });

  it('② 상세 단건: super_admin=rrnMasked 동봉 · 매니저=기본만 · 강사 403 · 미존재 404', async () => {
    // OTP 가입 계정(rrn 보유)으로 rrnMasked 검증
    const challengeId = await verifiedSignupChallenge(http, 'crud-detail@t32.test');
    const created = (await http.post('/api/auth/signup').send({
      webId: 'crud_detail', name: '상세검증', email: 'crud-detail@t32.test', password: 'password123',
      rrn: '950101-1234567', emailChallengeId: challengeId, role: 'instructor',
    }).expect(201)).body.account;

    const superView = (await http.get(`/api/users/${created.id}`).set(auth(admin)).expect(200)).body;
    expect(superView.rrnMasked).toBe('950101-1******');
    expect(superView.rrnEncrypted).toBeUndefined(); // 암호문은 어떤 응답에도 없다
    const managerView = (await http.get(`/api/users/${created.id}`).set(auth(manager)).expect(200)).body;
    expect(managerView.rrnMasked).toBeUndefined(); // 주민번호 마스킹도 대표 전용
    await http.get(`/api/users/${created.id}`).set(auth(inst)).expect(403);
    await http.get('/api/users/99999').set(auth(admin)).expect(404);
  });

  it('③ 직접 등록 역할 확장: manager 생성 → 즉시 active·로그인 가능 (Create 버튼 경로)', async () => {
    const created = (await http.post('/api/users/instructors').set(sudoAdmin()).send({
      webId: 'crud_mgr', name: '직접매니저', password: 'password123', role: 'manager', email: 'crud-mgr@t32.test',
    }).expect(201)).body;
    expect(created).toMatchObject({ role: 'manager', status: 'active', emailVerified: true });
    await login('crud_mgr', 'password123');
    // 강사 프로필은 강사 역할만 생성된다
    expect(db.findBy<{ userId: number }>('instructor_profiles', (p) => p.userId === created.id)).toHaveLength(0);
    await http.post('/api/users/instructors').set(auth(manager)).send({
      webId: 'crud_x', name: 'x', password: 'password123',
    }).expect(403); // 대표 전용
  });

  it('④ 대표 직접 수정: name/phone 즉시 · role↔강사 원부 자동 전이 · 대상 구 토큰 401', async () => {
    const targetToken = await login('crud_mgr', 'password123');
    const target = db.findBy<{ id: number; webId: string }>('users', (u) => (u as { webId?: string }).webId === 'crud_mgr')[0];

    const renamed = (await http.patch(`/api/users/${target.id}`).set(sudoAdmin())
      .send({ name: '직접매니저 개명', phone: '010-9999-8888' }).expect(200)).body;
    expect(renamed).toMatchObject({ name: '직접매니저 개명', phone: '010-9999-8888' });
    await http.get('/api/auth/me').set(auth(targetToken)).expect(200); // name/phone만 — 세션 유지

    // 이메일 중복 → 400
    await http.patch(`/api/users/${target.id}`).set(sudoAdmin())
      .send({ email: 'admin@tnacademy.test' }).expect(400);

    // manager→instructor: 역할과 활성 강사 원부가 같은 command에서 생성된다.
    const promoted = (await http.patch(`/api/users/${target.id}`).set(sudoAdmin())
      .send({ role: 'instructor' }).expect(200)).body;
    expect(promoted.role).toBe('instructor');
    expect(app.get(InstructorProfilesStore).findActive(target.id)).toBeTruthy();
    await http.get('/api/auth/me').set(auth(targetToken)).expect(401);

    const instructorToken = await login('crud_mgr', 'password123');
    // instructor→admin: 참조가 없는 강사의 원부는 비활성화되고 다시 세션이 폐기된다.
    const demoted = (await http.patch(`/api/users/${target.id}`).set(sudoAdmin())
      .send({ role: 'admin' }).expect(200)).body;
    expect(demoted.role).toBe('admin');
    expect(app.get(InstructorProfilesStore).findActive(target.id)).toBeUndefined();
    await http.get('/api/auth/me').set(auth(instructorToken)).expect(401);
    await login('crud_mgr', 'password123');
  });

  it('⑤ 역할 전이 audit 실패 시 users와 instructor_profiles가 모두 rollback된다', async () => {
    const created = (await http.post('/api/users/instructors').set(sudoAdmin()).send({
      webId: 'crud_role_rollback', name: '역할롤백', password: 'password123',
      role: 'manager', email: 'crud-role-rollback@t32.test',
    }).expect(201)).body;
    const audit = app.get(AuditService);
    const original = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (entry) => {
      if (entry.entity === 'instructor_profiles') throw new Error('injected role profile audit failure');
      return original(entry);
    });
    await http.patch(`/api/users/${created.id}`).set(sudoAdmin())
      .send({ role: 'instructor' }).expect(500);
    spy.mockRestore();

    expect(db.findById<{ role: string }>('users', created.id)?.role).toBe('manager');
    expect(app.get(InstructorProfilesStore).find(created.id)).toBeUndefined();
  });

  it('⑥ 담당 수업이 남은 강사는 역할 해제를 거부하고 원부를 유지한다', async () => {
    const instructor = db.findBy<{ id: number }>('users', (row) =>
      (row as { webId?: string }).webId === 'park_inst',
    )[0];
    await http.patch(`/api/users/${instructor.id}`).set(sudoAdmin())
      .send({ role: 'manager' }).expect(409);
    expect(db.findById<{ role: string }>('users', instructor.id)?.role).toBe('instructor');
    expect(app.get(InstructorProfilesStore).findActive(instructor.id)).toBeTruthy();
  });

  it('⑦ 가드: super_admin 대상 수정 400 · 매니저 수정 403 · 전화 형식 400', async () => {
    await http.patch('/api/users/3').set(sudoAdmin()).send({ name: '대표 개명 시도' }).expect(400); // admin=super_admin id 3
    const target = db.findBy<{ id: number }>('users', (u) => (u as { webId?: string }).webId === 'crud_mgr')[0];
    await http.patch(`/api/users/${target.id}`).set(auth(manager)).send({ name: 'x' }).expect(403);
    await http.patch(`/api/users/${target.id}`).set(sudoAdmin()).send({ phone: '02-123' }).expect(400);
  });
});
