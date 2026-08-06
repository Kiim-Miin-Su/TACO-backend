// [TBO-86I-4] 등록 시점 가족 연결 — familyRelations를 학생·보호자·수강과 같은 tx로 생성한다.
//  성공 시 관계 행+양방향 aggregate+보호자 합집합, 실패(미존재 상대·배열 중복) 시 학생조차 +0.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import type { Student } from '../src/modules/students/student.entity';
import type { ParentStudent } from '../src/modules/parents/parent.entity';

describe('[TBO-86I-4] POST /students/registrations + familyRelations (같은 tx)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let token: string;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const counts = () => ({
    students: db.findAll<Student>('students').length,
    relations: db.findAll<{ id: number }>('student_family_relations').length,
    guardianLinks: db.findAll<ParentStudent>('parent_student_relations').length,
  });

  const profile = (name: string) => ({
    name, gender: 'undisclosed', birthDate: '2013-03-15', grade: 7, country: 'KR',
    residenceType: 'domestic', address: '서울시', schoolName: 'TACO School',
    phone: '010-8100-0000', counselTopic: '형제 등록 상담',
  });

  it('성공 — 첫째 등록(보호자 포함) 후 둘째를 familyRelations+linkGuardians로 등록하면 관계·보호자 합집합·양방향 aggregate가 한 tx에 생긴다', async () => {
    const first = (await http.post('/api/students/registrations').set(auth()).send({
      student: profile('가족 첫째'),
      guardians: [{ name: '가족 보호자', phone: '010-8100-9999', relation: '모' }],
    }).expect(201)).body;

    const before = counts();
    const second = (await http.post('/api/students/registrations').set(auth()).send({
      student: { ...profile('가족 둘째'), phone: '010-8100-0001' },
      familyRelations: [{ relatedStudentId: first.student.id, relationType: 'sibling', linkGuardians: true }],
    }).expect(201)).body;
    const after = counts();

    expect(after.students - before.students).toBe(1);
    expect(after.relations - before.relations).toBe(1);
    // 보호자 합집합 — 첫째의 보호자가 둘째에게도 관계 행으로 연결(비대표·비납부)
    expect(after.guardianLinks - before.guardianLinks).toBe(1);
    const linked = db.findBy<ParentStudent>('parent_student_relations', (row) => row.studentId === second.student.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ isPrimary: false, isPayer: false });

    // 양방향 family aggregate readback — 서로가 구성원으로 보인다
    const familyOfSecond = (await http.get(`/api/students/${second.student.id}/family`).set(auth()).expect(200)).body;
    expect(familyOfSecond.members.map((m: { student: { id: number } }) => m.student.id)).toContain(first.student.id);
    const familyOfFirst = (await http.get(`/api/students/${first.student.id}/family`).set(auth()).expect(200)).body;
    expect(familyOfFirst.members.map((m: { student: { id: number } }) => m.student.id)).toContain(second.student.id);
  });

  it('실패 rollback — 미존재 상대 학생이면 404이고 학생·관계·보호자 링크 전부 +0(등록 원자성)', async () => {
    const before = counts();
    await http.post('/api/students/registrations').set(auth()).send({
      student: { ...profile('가족 실패'), phone: '010-8100-0002' },
      guardians: [{ name: '실패 보호자', phone: '010-8100-8888', relation: '부' }],
      familyRelations: [{ relatedStudentId: 999999, relationType: 'sibling' }],
    }).expect(404);
    expect(counts()).toEqual(before);
  });

  it('실패 rollback — 배열 안에 같은 상대가 중복이면 409이고 전부 +0', async () => {
    const target = db.findAll<Student>('students')[0];
    const before = counts();
    await http.post('/api/students/registrations').set(auth()).send({
      student: { ...profile('가족 중복'), phone: '010-8100-0003' },
      familyRelations: [
        { relatedStudentId: target.id, relationType: 'sibling' },
        { relatedStudentId: target.id, relationType: 'other', relationLabel: '사촌' },
      ],
    }).expect(409);
    expect(counts()).toEqual(before);
  });
});
