import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// ─────────────────────────────────────────────────────────────
// 보호자(parents) — 실제 접수 담당자 흐름 통합 e2e.
//  학생 인테이크(부모 없는 학생3) → 모 등록(대표+납부) → 부 등록(납부) →
//  중복 연결 방지 → 형제(M:N) 연결 → 대표 이전(PATCH) → FK 음성.
//  불변식: 학생당 대표(primary) ≤ 1. (parent,student) 유니크.
// ─────────────────────────────────────────────────────────────
describe('Parents Flow (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const S3 = 3; // 박지민 — 시드상 보호자 없음(깨끗한 인테이크 대상)
  const rel = (rows: Array<{ studentId: number }>, sid: number) => rows.filter((r) => r.studentId === sid);
  const primaryOf = (rows: Array<{ studentId: number; isPrimary: boolean }>, sid: number) =>
    rows.filter((r) => r.studentId === sid && r.isPrimary);

  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('시드: 보호자 3 + 관계 3(각 학생 대표 1명)', async () => {
    const parents = (await http.get('/api/parents').expect(200)).body;
    const rels = (await http.get('/api/parents/relations').expect(200)).body;
    expect(parents.length).toBeGreaterThanOrEqual(3);
    expect(rels.length).toBeGreaterThanOrEqual(3);
    // 시드 각 학생(1·2·4)은 대표 정확히 1명
    for (const sid of [1, 2, 4]) expect(primaryOf(rels, sid).length).toBe(1);
  });

  it('1) 인테이크: 학생3은 아직 보호자 없음', async () => {
    const rels = (await http.get('/api/parents/relations').expect(200)).body;
    expect(rel(rels, S3).length).toBe(0);
  });

  let momId = 0;
  it('2) 모(김엄마) 등록 → 학생3 대표+납부', async () => {
    const res = await http.post('/api/parents').set(asAdmin())
      .send({ name: '김엄마', phone: '010-0000-0001', relation: '모', isPayer: true, isPrimary: true, studentId: S3 })
      .expect(201);
    expect(res.body.parent.id).toBeGreaterThan(3);
    expect(res.body.relation).toMatchObject({ studentId: S3, isPrimary: true, isPayer: true });
    momId = res.body.parent.id;
  });

  let dadId = 0;
  it('3) 부(김아빠) 등록 → 학생3 납부(대표 아님). 학생3 관계 2건·대표 1명', async () => {
    const res = await http.post('/api/parents').set(asAdmin())
      .send({ name: '김아빠', phone: '010-0000-0002', relation: '부', isPayer: true, isPrimary: false, studentId: S3 })
      .expect(201);
    dadId = res.body.parent.id;
    const rels = (await http.get('/api/parents/relations').expect(200)).body;
    expect(rel(rels, S3).length).toBe(2);
    const primary = primaryOf(rels, S3);
    expect(primary.length).toBe(1);
    expect(primary[0].parentId).toBe(momId); // 대표는 여전히 모
  });

  it('4) 중복 연결 방지: 모를 학생3에 다시 링크 → 409', async () => {
    await http.post('/api/parents/link').set(asAdmin()).send({ parentId: momId, studentId: S3 }).expect(409);
  });

  it('5) 형제(M:N): 모를 학생2에도 납부자로 연결(대표 아님) → 성공, 학생2 대표는 불변', async () => {
    const before = primaryOf((await http.get('/api/parents/relations').expect(200)).body, 2);
    await http.post('/api/parents/link').set(asAdmin())
      .send({ parentId: momId, studentId: 2, relation: '모', isPayer: true, isPrimary: false }).expect(201);
    const rels = (await http.get('/api/parents/relations').expect(200)).body;
    // 모는 이제 학생 2명(3, 2)과 연결
    const momRels = rels.filter((r: { parentId: number }) => r.parentId === momId);
    expect(momRels.map((r: { studentId: number }) => r.studentId).sort()).toEqual([2, 3]);
    // 학생2 대표는 그대로(비-primary 링크라 이전 없음)
    expect(primaryOf(rels, 2).length).toBe(1);
    expect(primaryOf(rels, 2)[0].parentId).toBe(before[0].parentId);
  });

  it('6) 대표 이전: 부를 학생3 대표로 승격(PATCH) → 모 강등, 대표 여전히 1명(부)', async () => {
    const rels0 = (await http.get('/api/parents/relations').expect(200)).body;
    const dadRel = rels0.find((r: { parentId: number; studentId: number }) => r.parentId === dadId && r.studentId === S3);
    await http.patch(`/api/parents/relations/${dadRel.id}`).set(asAdmin()).send({ isPrimary: true }).expect(200);
    const rels = (await http.get('/api/parents/relations').expect(200)).body;
    const primary = primaryOf(rels, S3);
    expect(primary.length).toBe(1);           // 불변: 대표 ≤ 1
    expect(primary[0].parentId).toBe(dadId);  // 이전 완료
  });

  it('7) FK 음성: 없는 보호자/학생 링크 → 400', async () => {
    await http.post('/api/parents/link').set(asAdmin()).send({ parentId: 99999, studentId: S3 }).expect(400);
    await http.post('/api/parents/link').set(asAdmin()).send({ parentId: momId, studentId: 99999 }).expect(400);
    await http.post('/api/parents').set(asAdmin()).send({ name: 'X', studentId: 99999 }).expect(400);
  });
});
