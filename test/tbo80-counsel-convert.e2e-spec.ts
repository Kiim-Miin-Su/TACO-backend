// [TBO-80 80E = TBO-30E] 상담→수강 전환 command e2e.
//
//  판정 축: ① 전환의 진실원 = enrollment.counselCardId FK(단순 status 표기가 아님)
//  ② 폼 registered 전이·수강 생성·양쪽 audit가 **한 transaction**(실패 시 부분 전환 0)
//  ③ 전이 가능 상태 기계(registered/dropped 재전환 409) ④ 관리 역할 전용.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { studentAggregateBody } from './fixtures/student-profile';

describe('POST /counsel/:id/convert (TBO-80 80E)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  let INSTRUCTOR = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });
  let studentId = 0;
  let formId = 0;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    INSTRUCTOR = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    // 신규 학생 + 상담 접수(시드 무의존 — 시드 수치 민감성 회피). 공용 fixture 헬퍼 재사용.
    const student = (await http.post('/api/students/registrations').set(asAdmin())
      .send(studentAggregateBody('TBO80 전환학생')).expect(201)).body;
    studentId = student.student?.id ?? student.id;
    formId = (await http.post('/api/counsel').set(asAdmin()).send({ studentId, referenceNotes: '전환 e2e' }).expect(201)).body.id;
  });
  afterAll(async () => { await app.close(); });

  it('강사는 전환 command 403', async () => {
    await http.post(`/api/counsel/${formId}/convert`).set({ Authorization: `Bearer ${INSTRUCTOR}` })
      .send({ courseId: 10 }).expect(403);
  });

  it('존재하지 않는 코스는 400 — 폼 상태는 그대로(부분 전환 없음)', async () => {
    await http.post(`/api/counsel/${formId}/convert`).set(asAdmin()).send({ courseId: 999_999 }).expect(400);
    const form = (await http.get(`/api/counsel/${formId}`).set(asAdmin()).expect(200)).body;
    expect(form.status).toBe('requested'); // 수강 생성 실패 → 전이도 없음(한 UoW)
  });

  it('전환 성공 — enrollment.counselCardId FK + 폼 registered + 양쪽 audit', async () => {
    const res = (await http.post(`/api/counsel/${formId}/convert`).set(asAdmin())
      .send({ courseId: 10, memo: 'TBO80 전환' }).expect(201)).body;
    expect(res.form.id).toBe(formId);
    expect(res.form.status).toBe('registered');
    expect(res.enrollment.studentId).toBe(studentId);
    expect(res.enrollment.courseId).toBe(10);
    expect(res.enrollment.counselCardId).toBe(formId); // 전환의 진실원 = FK
    // readback — 폼·수강 모두 영속 확인
    const form = (await http.get(`/api/counsel/${formId}`).set(asAdmin()).expect(200)).body;
    expect(form.status).toBe('registered');
    const enrollments = (await http.get(`/api/enrollments?studentId=${studentId}`).set(asAdmin()).expect(200)).body;
    const linked = enrollments.filter((row: { counselCardId?: number | null }) => row.counselCardId === formId);
    expect(linked).toHaveLength(1);
    // audit — 폼 전이 이력(entity 문자열은 승인 이력 탭과 같은 'counsel_forms')
    const audit = (await http.get(`/api/audit?entity=counsel_forms&entityId=${formId}`).set(asAdmin()).expect(200)).body;
    const converted = audit.filter((row: { action: string; reason?: string | null }) =>
      row.action === 'update' && (row.reason ?? '').includes('상담 전환'));
    expect(converted.length).toBeGreaterThanOrEqual(1);
  });

  it('이미 전환된 폼 재전환은 409 — 수강 중복도 생기지 않는다', async () => {
    await http.post(`/api/counsel/${formId}/convert`).set(asAdmin()).send({ courseId: 11 }).expect(409);
    const enrollments = (await http.get(`/api/enrollments?studentId=${studentId}`).set(asAdmin()).expect(200)).body;
    expect(enrollments.filter((row: { counselCardId?: number | null }) => row.counselCardId === formId)).toHaveLength(1);
  });

  it('dropped 폼은 409로 거부한다', async () => {
    const dropped = (await http.post('/api/counsel').set(asAdmin()).send({ studentId, referenceNotes: '이탈 케이스' }).expect(201)).body.id;
    await http.patch(`/api/counsel/${dropped}`).set(asAdmin()).send({ status: 'dropped' }).expect(200);
    await http.post(`/api/counsel/${dropped}/convert`).set(asAdmin()).send({ courseId: 11 }).expect(409);
  });

  it('같은 코스에 이미 수강이 있으면 409 — 폼 상태는 그대로(rollback 실증)', async () => {
    const again = (await http.post('/api/counsel').set(asAdmin()).send({ studentId, referenceNotes: '중복 수강 케이스' }).expect(201)).body.id;
    // formId 전환에서 코스 10 수강이 이미 생겼다 → 중복 생성은 EnrollmentsService가 409로 거부
    await http.post(`/api/counsel/${again}/convert`).set(asAdmin()).send({ courseId: 10 }).expect(409);
    const form = (await http.get(`/api/counsel/${again}`).set(asAdmin()).expect(200)).body;
    expect(form.status).toBe('requested'); // 수강 실패가 전이보다 먼저 — 부분 전환 없음
  });
});
