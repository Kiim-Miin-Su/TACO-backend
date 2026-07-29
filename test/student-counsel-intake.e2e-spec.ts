import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AuditService, type AuditEntry } from '../src/modules/audit/audit.service';
import { studentAggregateBody } from './fixtures/student-profile';

type CountSnapshot = Record<string, number>;

describe('[TBO-76C] student+counsel atomic intake', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const tokens: Record<string, string> = {};
  const auth = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const collections = [
    'students',
    'student_interests',
    'parents',
    'parent_student_relations',
    'enrollments',
    'counsel_forms',
    'audit_log',
  ];
  const counts = (): CountSnapshot => Object.fromEntries(
    collections.map((collection) => [collection, db.findAll(collection).length]),
  );
  const body = (name: string) => ({
    registration: {
      ...studentAggregateBody(name, { interests: [] }),
      guardians: [{
        name: `${name} 보호자`,
        phone: '010-7444-8899',
        relation: '모',
        isPrimary: true,
        isPayer: true,
      }],
    },
    counsel: {
      referenceNotes: `${name} 전화 상담 내용`,
      nextContactAt: '2099-08-01T10:30:00+09:00',
    },
  });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    for (const [role, webId] of Object.entries({
      super_admin: 'admin',
      admin: 'prof_admin',
      manager: 'manager',
      instructor: 'park_inst',
    })) {
      tokens[role] = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' })
        .expect(201)).body.accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('비로그인 401, 강사 403이며 manager/admin/super_admin은 원자 command를 사용할 수 있다', async () => {
    await http.post('/api/students/registrations/with-counsel').send(body('비로그인')).expect(401);
    await http.post('/api/students/registrations/with-counsel')
      .set(auth('instructor')).send(body('강사차단')).expect(403);

    for (const role of ['manager', 'admin', 'super_admin']) {
      const result = (await http.post('/api/students/registrations/with-counsel')
        .set(auth(role)).send(body(`76C ${role}`)).expect(201)).body;
      expect(result.registration.student.id).toBeGreaterThan(0);
      expect(result.registration.guardians).toHaveLength(1);
      expect(result.counsel).toMatchObject({
        studentId: result.registration.student.id,
        status: 'requested',
        source: 'manual',
        submitterType: 'staff',
        nextContactAt: '2099-08-01T01:30:00.000Z',
      });
      expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/);

      const aggregate = (await http.get(`/api/counsel/${result.counsel.id}/aggregate`)
        .set(auth(role)).expect(200)).body;
      expect(aggregate.student.student.id).toBe(result.registration.student.id);
      expect(aggregate.student.interests).toEqual([]);

      const marker = db.findBy<{ entity: string; entityId: number; reason?: string; changes?: unknown }>(
        'audit_log',
        (row) => row.entity === 'student_counsel_intakes' && row.entityId === result.counsel.id,
      )[0];
      expect(marker.reason).toBe(`correlation:${result.correlationId}`);
      const serialized = JSON.stringify(marker);
      expect(serialized).not.toContain('010-7444-8899');
      expect(serialized).not.toContain('전화 상담 내용');
    }
  });

  it('마지막 correlation audit 실패 시 학생·관심·보호자·관계·수강·상담·audit가 모두 +0이다', async () => {
    const before = counts();
    const audit = app.get(AuditService);
    const original = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation((entry: AuditEntry) => {
      if (entry.entity === 'student_counsel_intakes') throw new Error('injected intake correlation audit failure');
      return original(entry);
    });

    await http.post('/api/students/registrations/with-counsel')
      .set(auth('manager')).send(body('76C rollback')).expect(500);
    expect(counts()).toEqual(before);
    spy.mockRestore();
  });
});
