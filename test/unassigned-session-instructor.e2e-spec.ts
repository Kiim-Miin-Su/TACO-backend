import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditService } from '../src/modules/audit/audit.service';
import { ClassSessionsStore } from '../src/modules/schedule/class-sessions.store';
import { addDaysISO, createTestApp, E2E_APP_BOOT_TIMEOUT_MS, mondayISO, sudoAuthHeaders } from './setup-app';

jest.setTimeout(30_000);
jest.retryTimes(0);

describe('[TBO-86E] 배정중 수업과 사후 배정 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });
  const past = addDaysISO(mondayISO(), -400);
  let marker = 0;

  const openUnassigned = async (overrides: Record<string, unknown> = {}) => {
    marker += 1;
    return (await http.post('/api/schedule/open-class').set(auth('manager')).send({
      subjectName: `TBO86E Unassigned ${marker}`,
      instructorId: null,
      studentIds: [1],
      sessionDate: '2097-08-11',
      startTime: `${String(8 + marker).padStart(2, '0')}:00`,
      durationMinutes: 60,
      mode: 'online',
      ...overrides,
    }).expect(201)).body;
  };

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
    await http.patch('/api/instructors/1').set(sudoAuthHeaders(app, tokens.admin))
      .send({ defaultHourlyRate: 50_000 }).expect(200);
  }, E2E_APP_BOOT_TIMEOUT_MS);

  afterAll(async () => { if (app) await app.close(); });

  it('null을 가짜 ID 없이 course/session/resource에 영속화하고 출결·리포트를 차단한다', async () => {
    await http.post('/api/schedule/open-class').set(auth('manager')).send({
      subjectName: 'TBO86E Missing Instructor', studentIds: [1], sessionDate: '2097-08-10',
      startTime: '08:00', durationMinutes: 60, mode: 'online',
    }).expect(400);
    const made = await openUnassigned();
    expect(made.course).toMatchObject({ instructorId: null, hourlyRate: 0 });
    expect(made.row).toMatchObject({ instructorId: null, instructorName: null, attendanceRequired: false });

    const resources = (await http.get('/api/schedule/resources').set(auth('manager')).expect(200)).body;
    expect(resources.courses.find((course: { id: number }) => course.id === made.course.id))
      .toMatchObject({ instructorId: null, instructorName: null });
    expect(JSON.stringify(made)).not.toContain('"instructorId":0');
    const unassignedRows = (await http.get('/api/schedule').set(auth('manager'))
      .query({ assignment: 'unassigned' }).expect(200)).body;
    expect(unassignedRows).toEqual(expect.arrayContaining([expect.objectContaining({ id: made.row.id, instructorId: null })]));
    expect(unassignedRows.every((row: { instructorId: number | null }) => row.instructorId == null)).toBe(true);
    expect((await http.get('/api/schedule').set(auth('manager')).query({ assignment: 'assigned' }).expect(200)).body
      .every((row: { instructorId: number | null }) => row.instructorId != null)).toBe(true);
    await http.get('/api/schedule').set(auth('manager')).query({ assignment: 'unknown' }).expect(400);

    await http.put('/api/attendance').set(auth('manager'))
      .send({ sessionId: made.row.id, studentId: 1, status: 'present' }).expect(400);
    await http.put(`/api/schedule/${made.row.id}/instructor-attendance`).set(auth('manager'))
      .send({ status: 'present' }).expect(409);
    await http.post('/api/reports').set(auth('manager'))
      .send({ sessionId: made.row.id, studentId: 1, content: '배정 전 금지' }).expect(400);
  });

  it('사후 배정은 역할·CAS·충돌을 방어하고 성공 시 회차·감사를 원자 갱신한다', async () => {
    const made = await openUnassigned({ studentIds: [2], sessionDate: '2097-08-12', startTime: '10:00' });
    await http.put(`/api/schedule/${made.row.id}/instructor-assignment`).set(auth('park_inst'))
      .send({ instructorId: 1, expectedInstructorId: null, reason: '강사 임의 배정 차단' }).expect(403);

    const sessions = app.get(ClassSessionsStore);
    const originalFind = sessions.findByIdDb.bind(sessions);
    const staleCourse = jest.spyOn(sessions, 'findByIdDb').mockImplementationOnce(async (id) => {
      const row = await originalFind(id);
      return row ? { ...row, courseId: 10 } : row;
    });
    const stale = await http.put(`/api/schedule/${made.row.id}/instructor-assignment`).set(auth('manager'))
      .send({ instructorId: 1, expectedInstructorId: null, reason: '과목 변경 경쟁 상태 차단' }).expect(409);
    staleCourse.mockRestore();
    expect(stale.body).toMatchObject({ code: 'INSTRUCTOR_ASSIGNMENT_STALE', currentCourseId: 10 });
    expect((await http.get(`/api/schedule/${made.row.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorId: null, courseId: made.course.id });

    await http.post('/api/schedule').set(auth('manager')).send({
      courseId: 10, instructorId: 1, studentIds: [1], sessionDate: '2097-08-12',
      startTime: '10:00', durationMinutes: 60, mode: 'online',
    }).expect(201);
    const conflict = await http.put(`/api/schedule/${made.row.id}/instructor-assignment`).set(auth('manager'))
      .send({ instructorId: 1, expectedInstructorId: null, reason: '충돌 강사 배정 차단' }).expect(409);
    expect(conflict.body.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'double_book', resource: 'instructor', resourceId: 1 }),
    ]));

    const assignable = await openUnassigned({ sessionDate: '2097-08-13', startTime: '11:00' });
    const assigned = (await http.put(`/api/schedule/${assignable.row.id}/instructor-assignment`).set(auth('manager'))
      .send({ instructorId: 1, expectedInstructorId: null, reason: '담당 가능 강사 확정', setCourseDefault: true })
      .expect(200)).body;
    expect(assigned).toMatchObject({ previousInstructorId: null, courseDefaultUpdated: true });
    expect(assigned.row).toMatchObject({ instructorId: 1, instructorName: 'Jihoon Park' });
    await http.put(`/api/schedule/${assignable.row.id}/instructor-assignment`).set(auth('manager'))
      .send({ instructorId: 2, expectedInstructorId: null, reason: '오래된 화면 변경 차단' }).expect(409);
    expect((await http.get(`/api/courses/${assignable.course.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorId: 1 });
    const audits = (await http.get('/api/audit').set(auth('admin')).query({
      entity: 'class_sessions', entityId: assignable.row.id,
    }).expect(200)).body;
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'update', reason: '담당 가능 강사 확정' }),
    ]));
  });

  it('과거 배정중 회차는 배정만으로 완료되지 않고 출결·리포트 후 실제 강사 시급으로 정산된다', async () => {
    const made = await openUnassigned({ sessionDate: past, startTime: '07:00' });
    await http.put(`/api/schedule/${made.row.id}/instructor-assignment`).set(auth('manager'))
      .send({ instructorId: 1, expectedInstructorId: null, reason: '과거 회차 담당 강사 확인' }).expect(200);
    expect((await http.get(`/api/schedule/${made.row.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ status: 'scheduled', instructorId: 1, attendanceRequired: true });

    await http.put('/api/attendance').set(auth('manager'))
      .send({ sessionId: made.row.id, studentId: 1, status: 'present' }).expect(200);
    await http.put(`/api/schedule/${made.row.id}/instructor-attendance`).set(auth('manager'))
      .send({ status: 'present' }).expect(200);
    const report = (await http.post('/api/reports').set(auth('park_inst'))
      .send({ sessionId: made.row.id, studentId: 1, content: '사후 배정 정산 검증' }).expect(201)).body;
    await http.post(`/api/reports/${report.id}/submit`).set(auth('park_inst')).send({}).expect(201);
    await http.post(`/api/reports/${report.id}/approve`).set(auth('admin')).send({}).expect(201);

    const preview = (await http.get('/api/payouts/preview').set(auth('admin')).query({
      instructorId: 1, from: past, to: past,
    }).expect(200)).body;
    expect(preview.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: made.row.id, hourlyRate: 50_000, amount: 50_000 }),
    ]));
  });

  it('감사 저장 실패는 담당자와 코스 기본값을 모두 rollback한다', async () => {
    const made = await openUnassigned({ sessionDate: '2097-08-14', startTime: '02:00' });
    const audit = app.get(AuditService);
    const original = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log').mockImplementation(async (entry) => {
      if (entry.entity === 'class_sessions' && entry.reason === '배정 감사 실패 주입') {
        throw new Error('injected assignment audit failure');
      }
      return original(entry);
    });
    await http.put(`/api/schedule/${made.row.id}/instructor-assignment`).set(auth('manager'))
      .send({ instructorId: 1, expectedInstructorId: null, reason: '배정 감사 실패 주입', setCourseDefault: true })
      .expect(500);
    spy.mockRestore();
    expect((await http.get(`/api/schedule/${made.row.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorId: null, instructorName: null });
    expect((await http.get(`/api/courses/${made.course.id}`).set(auth('manager')).expect(200)).body)
      .toMatchObject({ instructorId: null });
  });
});
