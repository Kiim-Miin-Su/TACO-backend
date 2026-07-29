// [TBO-30G 2026-07-23 대표 지시] 가족(형제·자매) 테이블 조인 단일 진실원 검증.
//  ① GET /students/:id/family — 관계→학생→보호자→수강→상담 서버 조인 파생(사본 0)
//  ② 가족 연결 linkGuardians — 같은 tx에서 보호자 관계 행 합집합(parents 원부 복사 0·대표 불변·중복 skip)
//  ③ 양방향 동일 relationId(단일 행이 양쪽 화면의 진실원) · 역할 게이트 · 404
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import type { Parent, ParentStudent } from '../src/modules/parents/parent.entity';
import { studentAggregateBody } from './fixtures/student-profile';

describe('Family join SSOT (TBO-30G)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let inst = '';
  let aId = 0; // 동생(신규)
  let bId = 0; // 형(보호자·상담 보유)
  let parentId = 0;
  let counselId = 0;
  let relationId = 0;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    aId = (await http.post('/api/students').set(auth(admin))
      .send(studentAggregateBody('가족동생')).expect(201)).body.student.id;
    bId = (await http.post('/api/students').set(auth(admin))
      .send(studentAggregateBody('가족형')).expect(201)).body.student.id;
    // 형에게 대표 보호자 + 상담 카드 부여(조인 소스)
    parentId = (await http.post('/api/parents').set(auth(admin))
      .send({ name: '가족母', phone: '010-3030-4040', studentId: bId, relation: '모', isPrimary: true })
      .expect(201)).body.parent.id;
    counselId = (await http.post('/api/counsel').set(auth(admin))
      .send({ studentId: bId }).expect(201)).body.id;
  });
  afterAll(async () => { await app.close(); });

  it('linkGuardians — 보호자 관계 행 합집합: parents 복사 0·신규 링크 비대표·기존 대표 불변', async () => {
    const parentsBefore = db.findAll<Parent>('parents').length;
    relationId = (await http.post(`/api/students/${bId}/family-relations`).set(auth(admin))
      .send({ relatedStudentId: aId, relationType: 'sibling', linkGuardians: true }).expect(201)).body.id;
    // 보호자 원부는 복사되지 않는다(관계 행만 추가)
    expect(db.findAll<Parent>('parents').length).toBe(parentsBefore);
    // 동생에게 같은 parentId 연결이 생겼고, 비대표·비납부
    const aLink = db.findBy<ParentStudent>('parent_student_relations',
      (r) => r.studentId === aId && r.parentId === parentId)[0];
    expect(aLink).toMatchObject({ isPrimary: false, isPayer: false, relation: '모' });
    // 형의 기존 대표는 그대로 대표(강등 없음)
    const bPrimary = db.findBy<ParentStudent>('parent_student_relations',
      (r) => r.studentId === bId && r.parentId === parentId)[0];
    expect(bPrimary.isPrimary).toBe(true);
  });

  it('GET /students/:id/family — 학생·보호자·상담·공유 보호자 조인 파생(동생 시점)', async () => {
    const agg = (await http.get(`/api/students/${aId}/family`).set(auth(admin)).expect(200)).body;
    expect(agg.studentId).toBe(aId);
    expect(agg.members).toHaveLength(1);
    const member = agg.members[0];
    expect(member.relationId).toBe(relationId);
    expect(member.relationType).toBe('sibling');
    expect(member.student).toMatchObject({ id: bId, name: '가족형' }); // students 조인
    expect(member.student.schoolName).toBe('TACO School'); // 학사 read model 조인
    expect(member.guardians.map((g: { parent: { id: number } }) => g.parent.id)).toContain(parentId); // 보호자 조인
    expect(member.counselForms.map((c: { id: number }) => c.id)).toContain(counselId); // 상담 조인
    expect(member.counselForms[0]).toMatchObject({ status: 'requested', source: 'manual' });
    expect(member.sharedGuardianParentIds).toContain(parentId); // union 후 공유 보호자
    expect(member.activeEnrollmentCount).toBe(0);
  });

  it('양방향 단일 진실원 — 형 시점도 같은 relationId 한 행에서 파생', async () => {
    const agg = (await http.get(`/api/students/${bId}/family`).set(auth(admin)).expect(200)).body;
    const member = agg.members.find((m: { student: { id: number } }) => m.student.id === aId);
    expect(member.relationId).toBe(relationId); // 같은 관계 행(사본 아님)
    expect(member.sharedGuardianParentIds).toContain(parentId);
  });

  it('중복 가족 관계 409 · union은 이미 연결된 보호자 skip(멱등)', async () => {
    await http.post(`/api/students/${aId}/family-relations`).set(auth(admin))
      .send({ relatedStudentId: bId, relationType: 'sibling', linkGuardians: true }).expect(409);
    // 셋째(C)를 형에 연결 — 이미 A·B 둘 다 연결된 보호자는 C에만 새 링크가 생긴다
    const cId = (await http.post('/api/students').set(auth(admin))
      .send(studentAggregateBody('가족셋째')).expect(201)).body.student.id;
    const linksBefore = db.findBy<ParentStudent>('parent_student_relations', (r) => r.parentId === parentId).length;
    await http.post(`/api/students/${cId}/family-relations`).set(auth(admin))
      .send({ relatedStudentId: bId, relationType: 'sibling', linkGuardians: true }).expect(201);
    const links = db.findBy<ParentStudent>('parent_student_relations', (r) => r.parentId === parentId);
    expect(links.length).toBe(linksBefore + 1); // C 한 건만 추가(A·B는 skip)
    expect(links.filter((r) => r.isPrimary)).toHaveLength(1); // 대표는 여전히 형 1명
  });

  it('역할 게이트(강사 403) · 없는 학생 404', async () => {
    await http.get(`/api/students/${aId}/family`).set(auth(inst)).expect(403);
    await http.get('/api/students/999999/family').set(auth(admin)).expect(404);
  });
});
