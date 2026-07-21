// [TBO-29D D2] 학생 aggregate 원자 등록 e2e — 성공 시 4자산 동시 생성, 중간 실패 시 전부 +0,
//  보호자 전화 upsert-or-link, 같은 번호 동시 등록 직렬화(보호자 1행). in-memory·fresh-PG 이중 모드.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import {
  PARENTS_SPEC,
  PARENT_STUDENT_RELATIONS_SPEC,
  STUDENTS_SPEC,
  ENROLLMENTS_SPEC,
} from '../src/database/calendar-asset-specs';
import type { Parent, ParentStudent } from '../src/modules/parents/parent.entity';
import type { Student } from '../src/modules/students/student.entity';
import type { Enrollment } from '../src/modules/enrollments/enrollment.entity';

describe('[TBO-29D D2] POST /students/registrations (atomic aggregate)', () => {
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
    parents: db.findAll<Parent>('parents').length,
    relations: db.findAll<ParentStudent>('parent_student_relations').length,
    enrollments: db.findAll<Enrollment>('enrollments').length,
    audit: db.findAll<{ id: number }>('audit_log').length,
  });

  it('성공 — student+parent+relation+enrollment+audit가 한 번에 생기고 PG 재수화 후에도 유지', async () => {
    const before = counts();
    const res = await http.post('/api/students/registrations').set(auth()).send({
      student: { name: '통합 등록', grade: 9, country: 'KR' },
      guardian: { name: '통합 보호자', phone: '010-7777-0001', relation: '모' },
      courseId: 10,
    }).expect(201);
    const after = counts();
    expect(after).toEqual({
      students: before.students + 1,
      parents: before.parents + 1,
      relations: before.relations + 1,
      enrollments: before.enrollments + 1,
      // [감사 전수 2026-07-16] students 집계 1건 + parents create + relation create = +3
      audit: before.audit + 3,
    });
    expect(res.body.guardian.linkedExisting).toBe(false);
    expect(res.body.guardian.relation).toMatchObject({ studentId: res.body.student.id, isPrimary: true, isPayer: true });
    expect(res.body.enrollment).toMatchObject({ studentId: res.body.student.id, courseId: 10, status: 'active' });
    // audit에 PII 없음(전화·이름 미포함)
    const auditRow = db.findAll<{ entity: string; entityId: number; changes?: Record<string, unknown> }>('audit_log')
      .filter((a) => a.entity === 'students' && a.entityId === res.body.student.id).pop()!;
    expect(JSON.stringify(auditRow.changes)).not.toContain('010-7777-0001');
    expect(JSON.stringify(auditRow.changes)).not.toContain('통합 보호자');

    // PG 재수화 후 유지(D0/D1 규약)
    const pg = app.get(PostgresConnectionService);
    expect(typeof pg.ready).toBe('boolean');
    if (pg.ready) {
      const store = app.get(PostgresCollectionStore);
      await store.hydrate<Student>(STUDENTS_SPEC);
      await store.hydrate<Parent>(PARENTS_SPEC);
      await store.hydrate<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC);
      await store.hydrate<Enrollment>(ENROLLMENTS_SPEC);
    }
    expect(db.findById<Student>('students', res.body.student.id)?.name).toBe('통합 등록');
    expect(db.findById<ParentStudent>('parent_student_relations', res.body.guardian.relation.id)?.isPrimary).toBe(true);
    expect(db.findById<Enrollment>('enrollments', res.body.enrollment.id)?.status).toBe('active');

    // [TBO-35 35A] 캘린더 학생 피커도 별도 mock/목록이 아니라 같은 students DB row를 투영한다.
    // 신규 학생은 수강 여부와 무관하게 /students와 /schedule/resources에서 같은 id/name으로 보여야 한다.
    const studentList = (await http.get('/api/students').set(auth()).expect(200)).body;
    const calendarResources = (await http.get('/api/schedule/resources').set(auth()).expect(200)).body;
    expect(studentList.find((student: Student) => student.id === res.body.student.id)).toMatchObject({ name: '통합 등록' });
    expect(calendarResources.students.find((student: { id: number; name: string }) => student.id === res.body.student.id))
      .toMatchObject({ name: '통합 등록' });
  });

  it('실패 주입(enrollment 단계 — 미존재 코스) → 400 + 모든 자산 +0(부분 저장 없음)', async () => {
    const before = counts();
    await http.post('/api/students/registrations').set(auth()).send({
      student: { name: '롤백 학생', grade: 10 },
      guardian: { name: '롤백 보호자', phone: '010-7777-0002' },
      courseId: 999999,
    }).expect(400);
    expect(counts()).toEqual(before); // student·parent·relation·audit 전부 롤백
  });

  it('보호자 전화 일치 → 기존 parent에 연결(upsert-or-link, parents +0)', async () => {
    const before = counts();
    const res = await http.post('/api/students/registrations').set(auth()).send({
      student: { name: '형제 학생', grade: 7 },
      guardian: { name: '이름 달라도', phone: '010-7777-0001' }, // 첫 케이스의 번호 재사용
    }).expect(201);
    expect(res.body.guardian.linkedExisting).toBe(true);
    expect(res.body.guardian.parent.name).toBe('통합 보호자'); // 기존 이름 보존(덮어쓰지 않음)
    const after = counts();
    expect(after.parents).toBe(before.parents); // 보호자 신규 0
    expect(after.relations).toBe(before.relations + 1);
  });

  it('같은 번호 동시 등록 2건 → 보호자 정확히 1행 + 관계 2행(parentIntake lock 직렬화)', async () => {
    const phone = '010-7777-0003';
    const beforeParents = db.findAll<Parent>('parents').length;
    const [a, b] = await Promise.all([
      http.post('/api/students/registrations').set(auth()).send({ student: { name: '동시A', grade: 8 }, guardian: { name: '동시 보호자', phone } }),
      http.post('/api/students/registrations').set(auth()).send({ student: { name: '동시B', grade: 8 }, guardian: { name: '동시 보호자', phone } }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(db.findAll<Parent>('parents').length).toBe(beforeParents + 1); // 1행만 증가
    expect(a.body.guardian.parent.id).toBe(b.body.guardian.parent.id);
    const primaries = [a.body.guardian.relation, b.body.guardian.relation].filter((r) => r.isPrimary);
    expect(primaries.length).toBeGreaterThanOrEqual(1); // 각 학생별 대표 1명씩(서로 다른 학생)
  });

  it('권한 — 강사는 403(관리자 전용 등록)', async () => {
    const inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.post('/api/students/registrations').set({ Authorization: `Bearer ${inst}` })
      .send({ student: { name: '권한 테스트' } }).expect(403);
  });
});
