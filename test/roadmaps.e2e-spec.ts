// [TBO-47 2026-07-23] 수강 로드맵(마지막 dormant 도메인) e2e — 계획 §2 수용 기준 전항.
//  CRUD 왕복 · courseIds 일괄 생성(한 tx) · 중복 연결 409 · 없는 코스 400 · reorder 연속성(부분 목록 400) ·
//  soft delete 캐스케이드 · 역할 게이트(강사 읽기 200/쓰기 403) · PG 재수화 생존(dormant 갭 회귀 가드).
//  코스 원부는 courses SSOT — aggregate의 courseName/subjectId는 조인 파생(사본 저장 0)임을 함께 판정.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { PostgresConnectionService } from '../src/database/postgres-connection.service';
import { ROADMAPS_SPEC, ROADMAP_COURSES_SPEC } from '../src/database/calendar-asset-specs';
import type { Roadmap, RoadmapCourse } from '../src/modules/roadmaps/roadmap.entity';
import { studentAggregateBody } from './fixtures/student-profile';

type AggregateCourse = { linkId: number; courseId: number; sortOrder: number; courseName: string; subjectId: number };
type Aggregate = Roadmap & { courses: AggregateCourse[] };
type Audit = { entity: string; entityId: number; action: string; actorId: number; reason?: string };

describe('[TBO-47] Roadmaps — 코스 묶음 카탈로그 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  let admin = '';
  let inst = '';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    inst = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  const rehydrate = async (): Promise<boolean> => {
    const pg = app.get(PostgresConnectionService);
    expect(typeof pg.ready).toBe('boolean'); // 속성 오타 vacuous pass 방지(D0 학습)
    if (!pg.ready) return false;
    await app.get(PostgresCollectionStore).hydrate<Roadmap>(ROADMAPS_SPEC);
    await app.get(PostgresCollectionStore).hydrate<RoadmapCourse>(ROADMAP_COURSES_SPEC);
    return true;
  };
  const linksOf = (roadmapId: number) =>
    db.findAll<RoadmapCourse>('roadmap_courses').filter((link) => link.roadmapId === roadmapId);
  const audits = (entity: string, entityId: number): Audit[] =>
    db.findAll<Audit>('audit_log').filter((a) => a.entity === entity && a.entityId === entityId);

  it('시드 로드맵이 aggregate로 조회된다 — 코스명은 courses SSOT 조인 파생(하이드레이트 갭 회귀)', async () => {
    const seeded = (await http.get('/api/roadmaps/1').set(auth(admin)).expect(200)).body as Aggregate;
    expect(seeded.title).toBe('SAT 종합 로드맵');
    expect(seeded.courses.map((c) => c.courseId)).toEqual([10, 12]);
    expect(seeded.courses.map((c) => c.sortOrder)).toEqual([0, 1]);
    expect(seeded.courses.map((c) => c.courseName)).toEqual(['SAT Reading 정규', 'TOEFL 정규']); // 조인 파생 — 사본 0
    expect(seeded.courses.every((c) => c.subjectId === 1)).toBe(true);
  });

  it('CRUD 왕복 — courseIds 일괄 생성(순서 보존 한 tx) → 수정 → 목록 노출 + audit 이력', async () => {
    const created = (await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: 'SAT 완성 12주', targetGrade: 11, durationWeeks: 12, courseIds: [12, 10] })
      .expect(201)).body as Aggregate;
    expect(created.isActive).toBe(true);
    expect(created.courses.map((c) => c.courseId)).toEqual([12, 10]); // 입력 순서 그대로
    expect(created.courses.map((c) => c.sortOrder)).toEqual([0, 1]);

    const fetched = (await http.get(`/api/roadmaps/${created.id}`).set(auth(admin)).expect(200)).body as Aggregate;
    expect(fetched).toMatchObject({ title: 'SAT 완성 12주', targetGrade: 11, durationWeeks: 12 });

    const updated = (await http.patch(`/api/roadmaps/${created.id}`).set(auth(admin))
      .send({ title: 'SAT 완성 12주(개정)', isActive: false }).expect(200)).body as Aggregate;
    expect(updated).toMatchObject({ title: 'SAT 완성 12주(개정)', isActive: false, targetGrade: 11 });

    const list = (await http.get('/api/roadmaps').set(auth(admin)).expect(200)).body as Aggregate[];
    expect(list.some((r) => r.id === created.id)).toBe(true);
    expect(list.findIndex((r) => r.id === 1)).toBeLessThan(list.findIndex((r) => r.id === created.id)); // 활성 우선 정렬

    expect(audits('roadmaps', created.id).map((a) => a.action)).toEqual(['create', 'update']);
  });

  it('생성 검증 — 없는 코스 400 · courseIds 중복 400 · 부분 생성 잔존 0', async () => {
    const before = db.findAll<Roadmap>('roadmaps').length;
    await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '깨진 로드맵', courseIds: [10, 999999] }).expect(400);
    await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '중복 로드맵', courseIds: [10, 10] }).expect(400);
    expect(db.findAll<Roadmap>('roadmaps').length).toBe(before); // 로드맵 본체도 잔존 금지
  });

  it('수강 roadmapId 무결성 — 활성 로드맵 포함 코스만 연결되고 실패 시 수강·감사 잔존 0', async () => {
    const student = (await http.post('/api/students').set(auth(admin))
      .send(studentAggregateBody('로드맵수강학생')).expect(201)).body.student as { id: number };
    const active = (await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '수강 연결 검증', courseIds: [10] }).expect(201)).body as Aggregate;
    const inactive = (await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '비활성 수강 연결 검증', courseIds: [12] }).expect(201)).body as Aggregate;
    await http.patch(`/api/roadmaps/${inactive.id}`).set(auth(admin))
      .send({ isActive: false }).expect(200);

    const before = db.findAll<{ studentId: number }>('enrollments')
      .filter((row) => row.studentId === student.id).length;
    await http.post('/api/enrollments').set(auth(admin))
      .send({ studentId: student.id, courseId: 11, roadmapId: active.id }).expect(400);
    await http.post('/api/enrollments').set(auth(admin))
      .send({ studentId: student.id, courseId: 12, roadmapId: inactive.id }).expect(400);
    await http.post('/api/enrollments').set(auth(admin))
      .send({ studentId: student.id, courseId: 11, roadmapId: 999999 }).expect(400);
    expect(db.findAll<{ studentId: number }>('enrollments')
      .filter((row) => row.studentId === student.id)).toHaveLength(before);

    const created = (await http.post('/api/enrollments').set(auth(admin))
      .send({ studentId: student.id, courseId: 10, roadmapId: active.id, totalSessions: 8 })
      .expect(201)).body;
    expect(created).toMatchObject({
      studentId: student.id,
      courseId: 10,
      roadmapId: active.id,
      totalSessions: 8,
      completedSessions: 0,
      status: 'active',
    });
    expect(
      db.findAll<Audit>('audit_log')
        .some((row) => row.entity === 'enrollments' && row.entityId === created.id && row.action === 'create'),
    ).toBe(true);

    await http.patch(`/api/roadmaps/${active.id}`).set(auth(admin))
      .send({ isActive: false }).expect(409);
    await http.delete(`/api/roadmaps/${active.id}/courses/10`).set(auth(admin)).expect(409);
    await http.delete(`/api/roadmaps/${active.id}`).set(auth(admin)).expect(409);
    expect((await http.get(`/api/roadmaps/${active.id}`).set(auth(admin)).expect(200)).body)
      .toMatchObject({ isActive: true });

    await http.patch(`/api/enrollments/${created.id}`).set(auth(admin))
      .send({ status: 'canceled', reason: '로드맵 비활성화 정책 검증' }).expect(200);
    expect((await http.patch(`/api/roadmaps/${active.id}`).set(auth(admin))
      .send({ isActive: false }).expect(200)).body).toMatchObject({ isActive: false });
    await http.delete(`/api/roadmaps/${active.id}/courses/10`).set(auth(admin)).expect(409);
    await http.delete(`/api/roadmaps/${active.id}`).set(auth(admin)).expect(409);
  });

  it('코스 연결 — 중복 409 · 없는 코스 400 · 말단 sortOrder · 해제 시 연속 재정렬', async () => {
    const roadmap = (await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '연결 검증', courseIds: [10, 12] }).expect(201)).body as Aggregate;

    await http.post(`/api/roadmaps/${roadmap.id}/courses`).set(auth(admin)).send({ courseId: 10 }).expect(409);
    await http.post(`/api/roadmaps/${roadmap.id}/courses`).set(auth(admin)).send({ courseId: 999999 }).expect(400);

    const added = (await http.post(`/api/roadmaps/${roadmap.id}/courses`).set(auth(admin))
      .send({ courseId: 11 }).expect(201)).body as Aggregate;
    expect(added.courses.map((c) => c.courseId)).toEqual([10, 12, 11]); // 말단 연결
    expect(added.courses.map((c) => c.sortOrder)).toEqual([0, 1, 2]);

    // 가운데(12) 해제 → 잔여 sortOrder가 구멍 없이 0..n-1로 재정렬돼야 한다
    const removed = (await http.delete(`/api/roadmaps/${roadmap.id}/courses/12`).set(auth(admin)).expect(200)).body as Aggregate;
    expect(removed.courses.map((c) => c.courseId)).toEqual([10, 11]);
    expect(removed.courses.map((c) => c.sortOrder)).toEqual([0, 1]);
    await http.delete(`/api/roadmaps/${roadmap.id}/courses/12`).set(auth(admin)).expect(404); // 이미 해제됨
  });

  it('전체 재정렬 — 순서 교체 성공 · 부분 목록 400 · 이물 courseId 400(조용한 누락 금지)', async () => {
    const roadmap = (await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '재정렬 검증', courseIds: [10, 12, 11] }).expect(201)).body as Aggregate;

    const reordered = (await http.patch(`/api/roadmaps/${roadmap.id}/courses/reorder`).set(auth(admin))
      .send({ courseIds: [11, 10, 12] }).expect(200)).body as Aggregate;
    expect(reordered.courses.map((c) => c.courseId)).toEqual([11, 10, 12]);
    expect(reordered.courses.map((c) => c.sortOrder)).toEqual([0, 1, 2]);

    await http.patch(`/api/roadmaps/${roadmap.id}/courses/reorder`).set(auth(admin))
      .send({ courseIds: [11, 10] }).expect(400); // 부분 목록
    await http.patch(`/api/roadmaps/${roadmap.id}/courses/reorder`).set(auth(admin))
      .send({ courseIds: [11, 10, 999999] }).expect(400); // 이물 courseId
    const after = (await http.get(`/api/roadmaps/${roadmap.id}`).set(auth(admin)).expect(200)).body as Aggregate;
    expect(after.courses.map((c) => c.courseId)).toEqual([11, 10, 12]); // 실패 시 순서 무변형
  });

  it('soft delete — 링크 캐스케이드(한 tx) 후 404 · audit reason에 링크 수 기록', async () => {
    const roadmap = (await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '삭제 검증', courseIds: [10, 12] }).expect(201)).body as Aggregate;
    expect(linksOf(roadmap.id)).toHaveLength(2);

    await http.delete(`/api/roadmaps/${roadmap.id}`).set(auth(admin)).expect(200);
    await http.get(`/api/roadmaps/${roadmap.id}`).set(auth(admin)).expect(404);
    expect(linksOf(roadmap.id)).toHaveLength(0); // 고아 링크 재노출 방지
    const deletion = audits('roadmaps', roadmap.id).find((a) => a.action === 'delete');
    expect(deletion?.reason).toBe('cascade-links:2');
  });

  it('역할 게이트 — 비로그인 401 · 강사 읽기 200/쓰기 403', async () => {
    await http.get('/api/roadmaps').expect(401);
    expect(Array.isArray((await http.get('/api/roadmaps').set(auth(inst)).expect(200)).body)).toBe(true);
    await http.get('/api/roadmaps/1').set(auth(inst)).expect(200);
    await http.post('/api/roadmaps').set(auth(inst)).send({ title: '차단' }).expect(403);
    await http.patch('/api/roadmaps/1').set(auth(inst)).send({ title: '차단' }).expect(403);
    await http.delete('/api/roadmaps/1').set(auth(inst)).expect(403);
    await http.post('/api/roadmaps/1/courses').set(auth(inst)).send({ courseId: 11 }).expect(403);
    await http.patch('/api/roadmaps/1/courses/reorder').set(auth(inst)).send({ courseIds: [12, 10] }).expect(403);
  });

  it('없는 id — GET/PATCH/DELETE/연결 전부 404', async () => {
    await http.get('/api/roadmaps/999999').set(auth(admin)).expect(404);
    await http.patch('/api/roadmaps/999999').set(auth(admin)).send({ title: '없음' }).expect(404);
    await http.delete('/api/roadmaps/999999').set(auth(admin)).expect(404);
    await http.post('/api/roadmaps/999999/courses').set(auth(admin)).send({ courseId: 10 }).expect(404);
  });

  it('PG 재수화 생존 — 생성·연결이 hydrate 후에도 유지(dormant 갭이었다면 증발)', async () => {
    const created = (await http.post('/api/roadmaps').set(auth(admin))
      .send({ title: '재수화 검증', targetGrade: 9, courseIds: [11] }).expect(201)).body as Aggregate;
    await rehydrate();
    const roadmap = db.findById<Roadmap>('roadmaps', created.id);
    expect(roadmap?.title).toBe('재수화 검증');
    const links = linksOf(created.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ courseId: 11, sortOrder: 0 });
  });
});
