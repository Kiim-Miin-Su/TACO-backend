// [TBO-29D D0] 학생 삭제의 수강 취소 cascade 영속 회귀 — 구 코드는 enrollment 취소가
//  db.update(메모리 전용)로만 쓰여 PG에 미영속(재수화 시 취소가 되살아나는 실버그).
//  메모리 read model만 읽으면 통과해 버리므로, PG 모드에서는 **재수화(hydrate) 후** 상태를 판정한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { ENROLLMENTS_SPEC } from '../src/database/calendar-asset-specs';
import type { Enrollment } from '../src/modules/enrollments/enrollment.entity';
import { studentAggregateBody } from './fixtures/student-profile';
import { AuditService } from '../src/modules/audit/audit.service';

describe('[TBO-29D D0] student remove cascades enrollments (write-through)', () => {
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

  const auth = () => sudoAuthHeaders(app, token);

  it('soft delete + 활성 수강 전부 canceled(같은 tx)', async () => {
    const student = (await http.post('/api/students').set(auth())
      .send(studentAggregateBody('D0 카스케이드', { student: { grade: 11 } })).expect(201)).body.student;
    const enrollment = (await http.post('/api/enrollments').set(auth()).send({ studentId: student.id, courseId: 10 }).expect(201)).body;

    await http.delete(`/api/students/${student.id}`).set(auth()).expect(200);

    const row = db.findById<Enrollment>('enrollments', enrollment.id)!;
    expect(row.status).toBe('canceled');
  });

  it('[회귀 핵심] PG 재수화 후에도 취소가 유지된다 — 메모리 전용 쓰기였다면 되살아난다', async () => {
    const student = (await http.post('/api/students').set(auth())
      .send(studentAggregateBody('D0 재수화', { student: { grade: 12 } })).expect(201)).body.student;
    const enrollment = (await http.post('/api/enrollments').set(auth()).send({ studentId: student.id, courseId: 10 }).expect(201)).body;
    await http.delete(`/api/students/${student.id}`).set(auth()).expect(200);

    const pg = app.get(PostgresConnectionService);
    expect(typeof pg.ready).toBe('boolean'); // 속성명 오타로 vacuous pass가 되는 것 방지
    if (pg.ready) {
      // PG 권위에서 다시 읽어 메모리를 교체 — 여기서 canceled가 아니면 write-through 누락.
      await app.get(PostgresCollectionStore).hydrate<Enrollment>(ENROLLMENTS_SPEC);
    }
    const row = db.findById<Enrollment>('enrollments', enrollment.id)!;
    expect(row.status).toBe('canceled');
  });

  it('미존재 학생 404 — 수강 행 변화 0', async () => {
    const before = db.findAll<Enrollment>('enrollments').map((e) => `${e.id}:${e.status}`).join(',');
    await http.delete('/api/students/999999').set(auth()).expect(404);
    const after = db.findAll<Enrollment>('enrollments').map((e) => `${e.id}:${e.status}`).join(',');
    expect(after).toBe(before);
  });

  it('cascade 마지막 audit 실패 시 학생·수강·관심·보호자·가족·학사·audit가 전부 before로 롤백된다', async () => {
    const firstBody = {
      ...studentAggregateBody('D0 전체롤백A'),
      guardian: { name: 'D0 보호자', phone: '010-9333-0000', relation: '모' },
    };
    const first = (await http.post('/api/students').set(auth()).send(firstBody).expect(201)).body.student;
    const second = (await http.post('/api/students').set(auth())
      .send(studentAggregateBody('D0 전체롤백B')).expect(201)).body.student;
    await http.post('/api/enrollments').set(auth())
      .send({ studentId: first.id, courseId: 10 })
      .expect(201);
    await http.post(`/api/students/${first.id}/family-relations`).set(auth())
      .send({ relatedStudentId: second.id, relationType: 'sibling' })
      .expect(201);

    const tables = [
      'students',
      'enrollments',
      'student_interests',
      'parent_student_relations',
      'student_family_relations',
      'student_academic_histories',
      'audit_log',
    ] as const;
    const snapshot = () => Object.fromEntries(tables.map((table) => [
      table,
      db.findAll<Record<string, unknown>>(table, { withDeleted: true })
        .map((row) => JSON.stringify(row))
        .sort(),
    ]));
    const before = snapshot();
    const audit = app.get(AuditService);
    const original = audit.log.bind(audit);
    const failure = jest.spyOn(audit, 'log').mockImplementation(async (entry) => {
      if (entry.entity === 'students' && entry.entityId === first.id && entry.action === 'delete') {
        throw new Error('injected final student delete audit failure');
      }
      return original(entry);
    });

    await http.delete(`/api/students/${first.id}`).set(auth()).expect(500);
    failure.mockRestore();

    expect(snapshot()).toEqual(before);
    await http.get(`/api/students/${first.id}/aggregate`).set(auth()).expect(200);
  });
});
