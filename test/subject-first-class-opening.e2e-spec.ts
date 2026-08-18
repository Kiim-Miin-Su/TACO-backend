import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';

describe('Subject-first class opening aggregate (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let admin = '';
  let instructor = '';
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  // [TBO-79 C1] /instructors 변경 명령은 sudo(재인증) 쿠키를 요구한다.
  const sudoAuth = (token: string) => sudoAuthHeaders(app, token);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    admin = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    instructor = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.patch('/api/instructors/1').set(sudoAuth(admin))
      .send({ defaultHourlyRate: 50000, canTeachKinder: true }).expect(200);
  });

  afterAll(async () => { await app.close(); });

  it('관리자만 사용할 수 있고 과목명/강사 DTO를 방어한다', async () => {
    const base = { subjectName: 'Writing Lab', instructorId: 1, sessionDate: '2098-01-05', startTime: '09:00' };
    await http.post('/api/schedule/open-class').send(base).expect(401);
    await http.post('/api/schedule/open-class').set(auth(instructor)).send(base).expect(403);
    await http.post('/api/schedule/open-class').set(auth(admin)).send({ ...base, subjectName: '   ' }).expect(400);
    await http.post('/api/schedule/open-class').set(auth(admin)).send({ ...base, instructorId: 99999 }).expect(400);
  });

  it('과목+강사별 course+독립 참가자 세션+audit를 한 번에 만든다', async () => {
    const enrollmentsBefore = (await http.get('/api/enrollments').set(auth(admin)).expect(200)).body;
    const result = (await http.post('/api/schedule/open-class').set(auth(admin)).send({
      subjectName: '  Writing   Lab  ',
      instructorId: 1,
      studentIds: [1],
      hourlyRateOverride: 47000,
      coursePrice: 320000,
      isKinder: false,
      color: '#1F6FEB',
      sessionDate: '2098-01-05',
      startTime: '09:00',
      endTime: '10:30',
      mode: 'online',
      topic: 'Essay structure',
      memo: '교재 2장',
    }).expect(201)).body;

    expect(result.subject).toMatchObject({ name: 'Writing Lab' });
    expect(result.course).toMatchObject({
      name: 'Writing Lab', subjectId: result.subject.id, instructorId: 1,
      hourlyRate: 47000, hourlyRateOverride: 47000, price: 320000, isKinder: false,
    });
    expect(result).not.toHaveProperty('enrollments');
    expect(result.row).toMatchObject({
      courseId: result.course.id, subjectName: 'Writing Lab', courseName: 'Writing Lab', instructorId: 1,
      studentIds: [1], mode: 'online', topic: 'Essay structure', memo: '교재 2장', durationMinutes: 90,
    });
    const [scheduleReadback, subjectReadback, courseReadback, enrollmentsAfter] = await Promise.all([
      http.get('/api/schedule').set(auth(admin)).expect(200),
      http.get(`/api/subjects/${result.subject.id}`).set(auth(admin)).expect(200),
      http.get(`/api/courses/${result.course.id}`).set(auth(admin)).expect(200),
      http.get('/api/enrollments').set(auth(admin)).expect(200),
    ]);
    expect(scheduleReadback.body.find((row: { id: number }) => row.id === result.row.id)).toMatchObject({
      courseName: 'Writing Lab', subjectName: 'Writing Lab', instructorId: 1,
    });
    expect(subjectReadback.body).toMatchObject({ id: result.subject.id, name: 'Writing Lab' });
    expect(courseReadback.body).toMatchObject({
      id: result.course.id, name: 'Writing Lab', hourlyRateOverride: 47000,
    });
    expect(enrollmentsAfter.body).toEqual(enrollmentsBefore);
    for (const [entity, id] of [
      ['subjects', result.subject.id], ['courses', result.course.id], ['class_sessions', result.row.id],
    ] as const) {
      const audit = (await http.get(`/api/audit?entity=${entity}&entityId=${id}`).set(auth(admin)).expect(200)).body;
      expect(audit.some((row: { action: string }) => row.action === 'create')).toBe(true);
    }
  });

  it('같은 과목+강사는 기존 catalog를 재사용하고 수강 등록은 변경하지 않는다', async () => {
    const beforeSubjects = (await http.get('/api/subjects').set(auth(admin)).expect(200)).body;
    const beforeCourses = (await http.get('/api/courses').set(auth(admin)).expect(200)).body;
    const subject = beforeSubjects.find((row: { name: string }) => row.name === 'Writing Lab');
    const course = beforeCourses.find((row: { name: string; instructorId: number }) => row.name === 'Writing Lab' && row.instructorId === 1);
    const result = (await http.post('/api/schedule/open-class').set(auth(admin)).send({
      subjectName: 'writing lab', instructorId: 1, studentIds: [1], hourlyRateOverride: 52000,
      coursePrice: 350000, sessionDate: '2098-01-06', startTime: '11:00', durationMinutes: 60,
    }).expect(201)).body;
    expect(result.subject.id).toBe(subject.id);
    expect(result.course).toMatchObject({ id: course.id, name: 'Writing Lab', hourlyRate: 52000, hourlyRateOverride: 52000, price: 350000 });
    const enrollments = (await http.get('/api/enrollments').set(auth(admin)).expect(200)).body
      .filter((row: { studentId: number; courseId: number }) => row.studentId === 1 && row.courseId === course.id);
    expect(enrollments).toHaveLength(0);
  });

  it('반복 개설은 기존 bulk command로 series와 occurrence 전체를 원자 생성한다', async () => {
    const result = (await http.post('/api/schedule/open-class-series').set(auth(admin)).send({
      subjectName: 'Writing Lab', instructorId: 1, studentIds: [1], hourlyRateOverride: null,
      repeat: { kind: 'weekly', weekdays: [1], startsOn: '2098-01-13', endsOn: '2098-01-20' },
      startTime: '13:00', endTime: '14:00', mode: 'in_person', topic: 'Weekly writing',
    }).expect(201)).body;
    expect(result.course).toMatchObject({ hourlyRate: 50000, hourlyRateOverride: null });
    expect(result.series.id).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row: { courseId: number; seriesId: number }) =>
      row.courseId === result.course.id && row.seriesId === result.series.id)).toBe(true);
  });

  it('후속 충돌 실패 시 새 subject/course가 부분 커밋되지 않는다', async () => {
    const marker = `Rollback ${Date.now()}`;
    await http.post('/api/schedule/open-class').set(auth(admin)).send({
      subjectName: marker, instructorId: 1, studentIds: [2], hourlyRateOverride: 48000,
      sessionDate: '2098-01-05', startTime: '09:30', endTime: '10:00',
    }).expect(409);
    const [subjects, courses, enrollments] = await Promise.all([
      http.get('/api/subjects').set(auth(admin)).expect(200),
      http.get('/api/courses').set(auth(admin)).expect(200),
      http.get('/api/enrollments').set(auth(admin)).expect(200),
    ]);
    expect(subjects.body.some((row: { name: string }) => row.name === marker)).toBe(false);
    expect(courses.body.some((row: { name: string }) => row.name === marker)).toBe(false);
    expect(enrollments.body.some((row: { studentId: number; courseId: number }) =>
      row.studentId === 2 && courses.body.some((course: { id: number; name: string }) => course.id === row.courseId && course.name === marker))).toBe(false);
  });

  // [TBO-61 2026-07-24] Kinder 가능 여부 게이트 제거(대표 지시 '유연하게') — 종전 "Kinder 불가
  //  강사 400 rollback" 테스트를 신정책 실증으로 대체(트랜잭션 rollback 자체는 위 409 케이스가 커버).
  it('Kinder는 강사 canTeachKinder와 무관하게 개설된다(유연화)', async () => {
    const marker = `Kinder flexible ${Date.now()}`;
    const result = (await http.post('/api/schedule/open-class').set(auth(admin)).send({
      subjectName: marker, instructorId: 2, isKinder: true, hourlyRateOverride: 40000,
      sessionDate: '2098-02-03', startTime: '09:00', durationMinutes: 60,
    }).expect(201)).body;
    expect(result.course).toMatchObject({ isKinder: true });
    const subjects = (await http.get('/api/subjects').set(auth(admin)).expect(200)).body;
    expect(subjects.some((row: { name: string }) => row.name === marker)).toBe(true);
  });
});
