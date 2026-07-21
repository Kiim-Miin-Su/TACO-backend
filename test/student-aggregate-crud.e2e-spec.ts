import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { PARENT_STUDENT_RELATIONS_SPEC, PARENTS_SPEC, STUDENT_INTERESTS_SPEC, STUDENTS_SPEC } from '../src/database/calendar-asset-specs';
import type { Student } from '../src/modules/students/student.entity';
import type { StudentInterest } from '../src/modules/students/student-interest.entity';
import type { Parent, ParentStudent } from '../src/modules/parents/parent.entity';

describe('[TBO-35 35C] student aggregate CRUD/RBAC/audit', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let ownerToken = '';
  let managerToken = '';
  let instructorToken = '';

  const owner = () => ({ Authorization: `Bearer ${ownerToken}` });
  const instructor = () => ({ Authorization: `Bearer ${instructorToken}` });
  const manager = () => ({ Authorization: `Bearer ${managerToken}` });
  const profile = (name: string, country = 'KR') => ({
    name, gender: 'female', birthDate: '2012-03-15', grade: 8, country,
    residenceType: country === 'KR' ? 'domestic' : 'overseas', address: country === 'KR' ? '서울시 강남구' : 'New York',
    addressDetail: '101호', schoolName: 'TACO School', phone: country === 'KR' ? '010-8123-4567' : '+1-212-555-0100',
    ...(country === 'KR' ? {} : { kakaoId: 'overseas-kakao' }), counselTopic: 'Writing 진단', status: 'new_inquiry',
  });
  const interests = [
    { courseId: 10, priority: 1 },
    { customLabel: 'Creative Writing', priority: 2 },
  ];

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    ownerToken = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    managerToken = (await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201)).body.accessToken;
    instructorToken = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('필수 profile·해외 Kakao·관심 2개·주보호자 불변을 저장 전 차단한다', async () => {
    await http.post('/api/students/registrations').set(owner()).send({ student: { name: '누락' }, interests }).expect(400);
    await http.post('/api/students/registrations').set(owner())
      .send({ student: { ...profile('해외누락', 'US'), kakaoId: undefined }, interests }).expect(400);
    await http.post('/api/students/registrations').set(owner()).send({ student: profile('관심누락'), interests: [interests[0]] }).expect(400);
    await http.post('/api/students/registrations').set(owner()).send({
      student: profile('대표중복'), interests,
      guardians: [{ name: '보호자1', isPrimary: true }, { name: '보호자2', isPrimary: true }],
    }).expect(409);
  });

  it('대표가 aggregate 생성·상세·수정·관심 CRUD·보호자 CRUD·soft delete를 수행하고 전 행 이력을 남긴다', async () => {
    const created = (await http.post('/api/students/registrations').set(owner()).send({
      student: profile('35C 학생'), interests,
      guardians: [{ name: '35C 보호자', phone: '010-8222-3333', relation: '모', isPayer: true }],
      courseId: 10,
    }).expect(201)).body;
    const studentId = created.student.id as number;
    const parentId = created.guardians[0].parent.id as number;
    const relationId = created.guardians[0].relation.id as number;

    const detail = (await http.get(`/api/students/${studentId}/aggregate`).set(instructor()).expect(200)).body;
    expect(detail.student).toMatchObject({ name: '35C 학생', status: 'new_inquiry' });
    expect(detail.interests.map((row: { priority: number }) => row.priority)).toEqual([1, 2]);
    expect(detail.guardians).toHaveLength(1);

    await http.patch(`/api/students/${studentId}/aggregate`).set(instructor())
      .send({ student: { status: 'enrolled' } }).expect(403);
    await http.patch(`/api/students/${studentId}/aggregate`).set(manager())
      .send({ student: { counselTopic: '매니저 상담 갱신' } }).expect(200);
    const updated = (await http.patch(`/api/students/${studentId}/aggregate`).set(owner()).send({
      student: { status: 'enrolled', counselTopic: 'Writing 등록 확정' },
      interests: [{ customLabel: 'Essay', priority: 1 }, { courseId: 10, priority: 2 }],
    }).expect(200)).body;
    expect(updated.student).toMatchObject({ status: 'enrolled', counselTopic: 'Writing 등록 확정' });
    expect(updated.interests).toHaveLength(2);

    const reordered = (await http.put(`/api/students/${studentId}/interests`).set(owner()).send([
      { courseId: 10, priority: 1 }, { customLabel: 'Essay', priority: 2 },
    ]).expect(200)).body;
    expect(reordered.map((row: { priority: number }) => row.priority)).toEqual([1, 2]);

    const added = (await http.post(`/api/students/${studentId}/interests`).set(owner())
      .send({ customLabel: 'Debate', priority: 3 }).expect(201)).body;
    await http.delete(`/api/students/${studentId}/interests/${added.id}`).set(instructor()).expect(403);
    await http.delete(`/api/students/${studentId}/interests/${reordered[0].id}`).set(owner()).expect(200);
    const remaining = (await http.get(`/api/students/${studentId}/interests`).set(owner()).expect(200)).body;
    expect(remaining).toHaveLength(2);
    expect(remaining.map((row: { priority: number }) => row.priority)).toEqual([1, 2]);
    await http.delete(`/api/students/${studentId}/interests/${remaining[0].id}`).set(owner()).expect(409);

    expect((await http.get(`/api/parents/${parentId}`).set(owner()).expect(200)).body.name).toBe('35C 보호자');
    await http.patch(`/api/parents/${parentId}`).set(owner()).send({ name: '35C 보호자 수정', phone: '010-8999-0000' }).expect(200);
    await http.patch(`/api/parents/relations/${relationId}`).set(owner()).send({ relation: '부', isPayer: false }).expect(200);
    await http.delete(`/api/parents/${parentId}`).set(owner()).expect(409);
    const guardianDelete = (await http.delete(`/api/parents/relations/${relationId}/guardian`).set(owner()).expect(200)).body;
    expect(guardianDelete).toEqual({ relationId, parentId, parentDeleted: true });

    const deleted = (await http.delete(`/api/students/${studentId}`).set(owner()).expect(200)).body;
    expect(deleted.deletedAt).toBeTruthy();
    await http.get(`/api/students/${studentId}`).set(owner()).expect(404);
    const resources = (await http.get('/api/schedule/resources').set(owner()).expect(200)).body;
    expect(resources.students.some((student: { id: number }) => student.id === studentId)).toBe(false);

    const studentAudits = db.findBy<any>('audit_log', (row) => row.entity === 'students' && row.entityId === studentId) as Array<{ action: string; actorId: number; changes?: unknown }>;
    expect(studentAudits.map((row) => row.action)).toEqual(expect.arrayContaining(['create', 'status_change', 'delete']));
    expect(new Set(studentAudits.map((row) => row.actorId))).toEqual(new Set([3, 4]));
    const serialized = JSON.stringify(studentAudits);
    expect(serialized).not.toContain('010-8123-4567');
    expect(serialized).not.toContain('서울시 강남구');

    const pg = app.get(PostgresConnectionService);
    if (pg.ready) {
      const store = app.get(PostgresCollectionStore);
      await store.hydrate<Student>(STUDENTS_SPEC);
      await store.hydrate<StudentInterest>(STUDENT_INTERESTS_SPEC);
      await store.hydrate<Parent>(PARENTS_SPEC);
      await store.hydrate<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC);
      expect(db.findById<Student>('students', studentId, { withDeleted: true })?.deletedAt).toBeTruthy();
      expect(db.findAll<StudentInterest>('student_interests', { withDeleted: true })
        .filter((row) => row.studentId === studentId).every((row) => row.deletedAt != null)).toBe(true);
      expect(db.findById<Parent>('parents', parentId, { withDeleted: true })?.deletedAt).toBeTruthy();
    }
  });
});
