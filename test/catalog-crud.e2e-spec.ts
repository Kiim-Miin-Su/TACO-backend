import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Catalog CRUD and RBAC (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin = '';
  let instructor = '';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    instructor = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });

  afterAll(async () => { await app.close(); });

  it('PATCH/DELETE는 비로그인 401, 강사 403으로 차단한다', async () => {
    await http.patch('/api/subjects/1').send({ name: '차단' }).expect(401);
    await http.delete('/api/courses/10').expect(401);
    await http.patch('/api/subjects/1').set(auth(instructor)).send({ name: '차단' }).expect(403);
    await http.delete('/api/courses/10').set(auth(instructor)).expect(403);
  });

  it('강사 수업 조회는 가격·시급 필드를 서버 응답에서 제외하고 관리자는 유지한다', async () => {
    const instructorRows = (await http.get('/api/courses').set(auth(instructor)).expect(200)).body as Array<Record<string, unknown>>;
    expect(instructorRows.length).toBeGreaterThan(0);
    for (const row of instructorRows) {
      expect(row).not.toHaveProperty('price');
      expect(row).not.toHaveProperty('hourlyRate');
      expect(row).not.toHaveProperty('hourlyRateOverride');
    }
    const instructorDetail = (await http.get('/api/courses/10').set(auth(instructor)).expect(200)).body;
    expect(instructorDetail).not.toHaveProperty('price');
    expect(instructorDetail).not.toHaveProperty('hourlyRate');
    expect(instructorDetail).not.toHaveProperty('hourlyRateOverride');

    const adminDetail = (await http.get('/api/courses/10').set(auth(admin)).expect(200)).body;
    expect(adminDetail).toHaveProperty('price');
    expect(adminDetail).toHaveProperty('hourlyRate');
    expect(adminDetail).toHaveProperty('hourlyRateOverride');
  });

  it('관리자는 과목·코스를 수정하고 미참조 자산을 soft delete할 수 있다', async () => {
    await http.patch('/api/instructors/1').set(auth(admin))
      .send({ defaultHourlyRate: 50000, canTeachKinder: true }).expect(200);
    const suffix = String(Date.now());
    const subject = (await http.post('/api/subjects').set(auth(admin))
      .send({ code: `review-${suffix}`, name: '리뷰 과목' }).expect(201)).body;
    const updatedSubject = (await http.patch(`/api/subjects/${subject.id}`).set(auth(admin))
      .send({ name: '리뷰 과목 수정' }).expect(200)).body;
    expect(updatedSubject.name).toBe('리뷰 과목 수정');

    const course = (await http.post('/api/courses').set(auth(admin)).send({
      name: '리뷰 코스', subjectId: subject.id, instructorId: 1, price: 100000,
      hourlyRateOverride: 40000, isKinder: false,
    }).expect(201)).body;
    expect(course).toMatchObject({ hourlyRateOverride: 40000, isKinder: false });
    const defaultCourse = (await http.post('/api/courses').set(auth(admin)).send({
      name: '강사 기본 페이 코스', subjectId: subject.id, instructorId: 1, price: 100000, isKinder: false,
    }).expect(201)).body;
    expect(defaultCourse).toMatchObject({ hourlyRate: 50000, hourlyRateOverride: null });
    const updatedCourse = (await http.patch(`/api/courses/${course.id}`).set(auth(admin))
      .send({ name: '리뷰 코스 수정', color: '#123456', isKinder: true }).expect(200)).body;
    expect(updatedCourse).toMatchObject({ name: '리뷰 코스 수정', color: '#123456', isKinder: true });

    const inherited = (await http.patch(`/api/courses/${course.id}`).set(auth(admin))
      .send({ hourlyRateOverride: null }).expect(200)).body;
    expect(inherited).toMatchObject({ hourlyRate: 50000, hourlyRateOverride: null });
    await http.patch('/api/instructors/1').set(auth(admin)).send({ defaultHourlyRate: 55000 }).expect(200);
    expect((await http.get(`/api/courses/${course.id}`).set(auth(admin)).expect(200)).body)
      .toMatchObject({ hourlyRate: 55000, hourlyRateOverride: null });

    // [TBO-61 2026-07-24] Kinder 가능 여부 게이트 제거(대표 지시 '유연하게') — canTeachKinder=false 강사도 Kinder 수업 개설 가능.
    const kinderFlexible = (await http.post('/api/courses').set(auth(admin)).send({
      name: 'Kinder 유연 개설', subjectId: subject.id, instructorId: 2, price: 100000,
      hourlyRateOverride: 40000, isKinder: true,
    }).expect(201)).body;
    expect(kinderFlexible.isKinder).toBe(true);
    await http.delete(`/api/courses/${kinderFlexible.id}`).set(auth(admin)).expect(200);

    await http.delete(`/api/subjects/${subject.id}`).set(auth(admin)).expect(409);
    await http.delete(`/api/courses/${defaultCourse.id}`).set(auth(admin)).expect(200);
    await http.delete(`/api/courses/${course.id}`).set(auth(admin)).expect(200);
    await http.delete(`/api/subjects/${subject.id}`).set(auth(admin)).expect(200);

    const courses = (await http.get('/api/courses').set(auth(admin)).expect(200)).body;
    const subjects = (await http.get('/api/subjects').set(auth(admin)).expect(200)).body;
    expect(courses.some((row: { id: number }) => row.id === course.id)).toBe(false);
    expect(subjects.some((row: { id: number }) => row.id === subject.id)).toBe(false);
  });

  it('수강·수업 등에서 참조 중인 기존 코스는 409로 보호한다', async () => {
    await http.delete('/api/courses/10').set(auth(admin)).expect(409);
  });
});
