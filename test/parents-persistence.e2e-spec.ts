// [TBO-29D D1] parents/relations 영속 회귀 — 메모리 전용 시절엔 재수화 시 전부 증발했다.
//  PG 모드에서는 hydrate(권위 재수화) 후에도 생성·대표 이전 결과가 유지되는지 판정한다(D0 규약 승계).
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { PARENTS_SPEC, PARENT_STUDENT_RELATIONS_SPEC } from '../src/database/calendar-asset-specs';
import type { Parent, ParentStudent } from '../src/modules/parents/parent.entity';

describe('[TBO-29D D1] parents persistence (write-through)', () => {
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

  const rehydrate = async () => {
    const pg = app.get(PostgresConnectionService);
    expect(typeof pg.ready).toBe('boolean'); // 속성 오타 vacuous pass 방지(D0 학습)
    if (!pg.ready) return false;
    await app.get(PostgresCollectionStore).hydrate<Parent>(PARENTS_SPEC);
    await app.get(PostgresCollectionStore).hydrate<ParentStudent>(PARENT_STUDENT_RELATIONS_SPEC);
    return true;
  };

  it('보호자 생성+연결 → PG 재수화 후에도 유지(메모리 전용이었다면 증발)', async () => {
    const created = (await http.post('/api/parents').set(auth())
      .send({ name: 'D1 보호자', phone: '010-9999-0001', studentId: 3, relation: '부', isPrimary: true })
      .expect(201)).body;
    await rehydrate();
    const parent = db.findById<Parent>('parents', created.parent.id)!;
    const relation = db.findById<ParentStudent>('parent_student_relations', created.relation.id)!;
    expect(parent?.name).toBe('D1 보호자');
    expect(relation).toMatchObject({ parentId: created.parent.id, studentId: 3, isPrimary: true });
  });

  it('대표 이전(강등+승격 한 tx) → 재수화 후에도 학생당 대표 1명 불변 유지', async () => {
    // 학생 1의 기존 대표=관계 1(김미경). 새 보호자를 대표로 연결 → 기존 대표는 강등돼야 한다.
    const created = (await http.post('/api/parents').set(auth())
      .send({ name: 'D1 새대표', phone: '010-9999-0002', studentId: 1, relation: '부', isPrimary: true })
      .expect(201)).body;
    await rehydrate();
    const primaries = db.findBy<ParentStudent>('parent_student_relations', (r) => r.studentId === 1 && r.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].parentId).toBe(created.parent.id);
  });

  it('중복 연결 409 — 재시도에도 행 +0(활성 unique의 앱 선방어)', async () => {
    const before = db.findAll<ParentStudent>('parent_student_relations').length;
    await http.post('/api/parents/link').set(auth()).send({ parentId: 1, studentId: 1, relation: '모' }).expect(409);
    expect(db.findAll<ParentStudent>('parent_student_relations').length).toBe(before);
  });
});
