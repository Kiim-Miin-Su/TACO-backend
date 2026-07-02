import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// 로드맵(roadmaps) 모듈 e2e — 시드·M:N 링크·courseIds FK 무결성.
describe('Roadmaps API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('GET /roadmaps — 시드 1건', async () => {
    const rows = (await http.get('/api/roadmaps').expect(200)).body;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ id: 1, title: 'SAT 종합 로드맵', isActive: true });
  });

  it('GET /roadmaps/courses — 링크 2건, 코스 FK·순서 정합', async () => {
    const links = (await http.get('/api/roadmaps/courses').expect(200)).body;
    const seedLinks = links.filter((l: { roadmapId: number }) => l.roadmapId === 1);
    expect(seedLinks.map((l: { courseId: number }) => l.courseId).sort()).toEqual([10, 12]);
    expect(seedLinks.every((l: { sortOrder: number }) => typeof l.sortOrder === 'number')).toBe(true);
  });

  it('POST /roadmaps — 코스 링크 생성(sortOrder 순서 보존)', async () => {
    const rm = (await http.post('/api/roadmaps').set(asAdmin())
      .send({ title: 'TOEFL 집중', description: '리스닝 강화', targetGrade: 10, courseIds: [12, 10] }).expect(201)).body;
    expect(rm.id).toBeGreaterThan(1);
    expect(rm.isActive).toBe(true);
    const links = (await http.get('/api/roadmaps/courses').expect(200)).body
      .filter((l: { roadmapId: number }) => l.roadmapId === rm.id)
      .sort((a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder);
    expect(links.map((l: { courseId: number }) => l.courseId)).toEqual([12, 10]); // 입력 순서 = sortOrder
  });

  it('POST /roadmaps — 없는 courseId → 400, 부분 생성 없음', async () => {
    const before = (await http.get('/api/roadmaps').expect(200)).body.length;
    const beforeLinks = (await http.get('/api/roadmaps/courses').expect(200)).body.length;
    await http.post('/api/roadmaps').set(asAdmin()).send({ title: '깨진 로드맵', courseIds: [10, 99999] }).expect(400);
    // 로드맵·링크 모두 생성되지 않아야(FK 검증이 삽입 전에 수행)
    expect((await http.get('/api/roadmaps').expect(200)).body.length).toBe(before);
    expect((await http.get('/api/roadmaps/courses').expect(200)).body.length).toBe(beforeLinks);
  });

  it('POST /roadmaps — 입력 courseIds 중복 → 400(ArrayUnique)', async () => {
    await http.post('/api/roadmaps').set(asAdmin()).send({ title: '중복', courseIds: [10, 10] }).expect(400);
  });

  it('POST /roadmaps — courseIds 없이도 생성 가능(링크 0)', async () => {
    const rm = (await http.post('/api/roadmaps').set(asAdmin()).send({ title: '빈 로드맵' }).expect(201)).body;
    const links = (await http.get('/api/roadmaps/courses').expect(200)).body
      .filter((l: { roadmapId: number }) => l.roadmapId === rm.id);
    expect(links.length).toBe(0);
  });
});
