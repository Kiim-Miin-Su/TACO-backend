import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, sudoAuthHeaders } from './setup-app';
import { AuditService } from '../src/modules/audit/audit.service';
import { studentAggregateBody } from './fixtures/student-profile';
import { dateInTimeZone } from '../src/modules/students/student-grade.policy';

const birthDateForAge = (age: number): string => {
  const [year, month, day] = dateInTimeZone().split('-').map(Number);
  return `${year - age}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

// ─────────────────────────────────────────────────────────────
// 학생(students) soft DELETE e2e.
//  DELETE /students/:id → deleted_at/deleted_by + 해당 학생 수강 canceled(무결성).
//  없는 학생 삭제 → 404.
// ─────────────────────────────────────────────────────────────
describe('Students Soft-Delete (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  let PROF_ADMIN = '';
  let MANAGER = '';
  let INSTRUCTOR = '';
  const asAdmin = () => sudoAuthHeaders(app, ADMIN);
  const asProfAdmin = () => sudoAuthHeaders(app, PROF_ADMIN);
  const asManager = () => sudoAuthHeaders(app, MANAGER);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    PROF_ADMIN = (await http.post('/api/auth/login').send({ webId: 'prof_admin', password: 'demo1234' }).expect(201)).body.accessToken;
    MANAGER = (await http.post('/api/auth/login').send({ webId: 'manager', password: 'demo1234' }).expect(201)).body.accessToken;
    INSTRUCTOR = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('DELETE 기존 학생 → active 조회 제외 + deletedAt 기록', async () => {
    // 시드 id/실행 순서에 의존하지 않고 이 테스트가 자신의 aggregate와 수강을 직접 준비한다.
    const created = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('삭제독립학생', { student: { status: 'enrolled' } })).expect(201)).body.student;
    await http.post('/api/enrollments').set(asAdmin()).send({ studentId: created.id, courseId: 10 }).expect(201);
    const before = (await http.get(`/api/students/${created.id}`).set(asAdmin()).expect(200)).body;
    expect(before).toMatchObject({ id: created.id, status: 'enrolled' });
    const enrBefore = (await http.get('/api/enrollments').set(asAdmin()).expect(200)).body
      .filter((e: { studentId: number }) => e.studentId === created.id);
    expect(enrBefore).toHaveLength(1);

    const res = await http.delete(`/api/students/${created.id}`).set(asAdmin()).expect(200);
    expect(res.body.deletedAt).toBeTruthy();
    expect(res.body.deletedBy).toBe(3);

    await http.get(`/api/students/${created.id}`).set(asAdmin()).expect(404);
    expect((await http.get('/api/students').set(asAdmin()).expect(200)).body.some((row: { id: number }) => row.id === created.id)).toBe(false);

    // 해당 학생 수강 전부 canceled
    const enrAfter = (await http.get('/api/enrollments').set(asAdmin()).expect(200)).body
      .filter((e: { studentId: number }) => e.studentId === created.id);
    expect(enrAfter.length).toBe(enrBefore.length);
    for (const e of enrAfter) expect(e.status).toBe('canceled');
  });

  it('학생 원부 삭제 뒤에도 보존된 수업 리포트는 역사 원부를 조인해 목록·상세에서 읽힌다', async () => {
    const created = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('리포트보존학생', { student: { status: 'enrolled' } })).expect(201)).body.student;
    await http.post('/api/enrollments').set(asAdmin()).send({ studentId: created.id, courseId: 10 }).expect(201);
    const session = (await http.post('/api/schedule/historical-completed').set({ Authorization: `Bearer ${MANAGER}` }).send({
      courseId: 10,
      instructorId: 1,
      studentIds: [created.id],
      sessionDate: '2025-08-12',
      startTime: '13:00',
      durationMinutes: 60,
      kind: 'class',
      mode: 'online',
      topic: 'soft-delete report projection',
      importReason: '학생 삭제 뒤 역사 리포트 조회 회귀 검증',
    }).expect(201)).body.row;
    const report = (await http.post('/api/reports').set({ Authorization: `Bearer ${INSTRUCTOR}` }).send({
      sessionId: session.id,
      studentId: created.id,
      content: '삭제 이후에도 보존할 수업 리포트',
      status: 'draft',
    }).expect(201)).body;

    await http.delete(`/api/students/${created.id}`).set(asManager()).expect(200);

    const list = (await http.get('/api/reports').set(asManager()).query({ studentId: created.id }).expect(200)).body;
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: report.id,
        context: expect.objectContaining({ student: expect.objectContaining({ id: created.id, name: '리포트보존학생' }) }),
      }),
    ]));
    await http.get(`/api/reports/${report.id}`).set(asManager()).expect(200)
      .expect(({ body }) => expect(body.context.student).toMatchObject({ id: created.id, name: '리포트보존학생' }));
  });

  it('DELETE 없는 학생 → 404', async () => {
    await http.delete('/api/students/99999').set(asAdmin()).expect(404);
  });

  it('퇴원·등록이탈은 조회 가능한 업무 상태이고 원부 soft delete만 목록에서 제외한다', async () => {
    const withdrawn = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('퇴원상태학생')).expect(201)).body.student;
    const lost = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('등록이탈학생')).expect(201)).body.student;

    await http.patch(`/api/students/${withdrawn.id}`).set(asAdmin()).send({ status: 'withdrawn' }).expect(200);
    await http.patch(`/api/students/${lost.id}`).set(asAdmin()).send({ status: 'registration_lost' }).expect(200);

    const activeOnly = (await http.get('/api/students').set(asAdmin()).expect(200)).body;
    expect(activeOnly.some((row: { id: number }) => row.id === withdrawn.id)).toBe(false);
    expect(activeOnly.some((row: { id: number }) => row.id === lost.id)).toBe(false);

    const afterStatus = (await http.get('/api/students?includeInactive=true').set(asAdmin()).expect(200)).body;
    expect(afterStatus).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: withdrawn.id, status: 'withdrawn' }),
      expect.objectContaining({ id: lost.id, status: 'registration_lost' }),
    ]));
    await http.get('/api/students?includeInactive=yes').set(asAdmin()).expect(400);
    await http.get(`/api/students/${withdrawn.id}/aggregate`).set(asAdmin()).expect(200);
    await http.get(`/api/students/${lost.id}/aggregate`).set(asAdmin()).expect(200);

    await http.delete(`/api/students/${withdrawn.id}`).set(asAdmin()).expect(200);
    const afterDelete = (await http.get('/api/students?includeInactive=true').set(asAdmin()).expect(200)).body;
    expect(afterDelete.some((row: { id: number }) => row.id === withdrawn.id)).toBe(false);
    expect(afterDelete.some((row: { id: number }) => row.id === lost.id)).toBe(true);
    await http.get(`/api/students/${withdrawn.id}/aggregate`).set(asAdmin()).expect(404);
  });

  it('manager와 admin은 sudo 후 원부 soft delete를 수행하고 강사는 차단된다', async () => {
    const managerStudent = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('매니저퇴원학생')).expect(201)).body.student;
    await http.patch(`/api/students/${managerStudent.id}`)
      .set({ Authorization: `Bearer ${MANAGER}` })
      .send({ status: 'withdrawn' })
      .expect(200);
    await http.post('/api/enrollments')
      .set({ Authorization: `Bearer ${MANAGER}` })
      .send({ studentId: managerStudent.id, courseId: 10 })
      .expect(400);
    await http.delete(`/api/students/${managerStudent.id}`)
      .set({ Authorization: `Bearer ${MANAGER}` })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('SUDO_REQUIRED'));
    await http.delete(`/api/students/${managerStudent.id}`).set(asManager()).expect(200);
    await http.get(`/api/students/${managerStudent.id}/aggregate`)
      .set({ Authorization: `Bearer ${MANAGER}` })
      .expect(404);

    const adminStudent = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('관리자삭제학생')).expect(201)).body.student;
    await http.delete(`/api/students/${adminStudent.id}`)
      .set({ Authorization: `Bearer ${PROF_ADMIN}` })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('SUDO_REQUIRED'));
    await http.delete(`/api/students/${adminStudent.id}`).set(asProfAdmin()).expect(200);

    await http.delete('/api/students/1')
      .set({ Authorization: `Bearer ${INSTRUCTOR}` })
      .expect(403);
  });

  it('프로필 입력을 컬럼 계약대로 저장하고 유효하지 않은 날짜·성별·상태는 400으로 차단한다', async () => {
    const payload = {
      name: '프로필학생', gender: 'undisclosed', birthDate: '2012-07-21', grade: 8,
      country: 'US', residenceType: 'overseas', address: 'Seattle', addressDetail: 'Unit 3',
      schoolName: 'TACO School', phone: '+1-206-555-0100', kakaoId: 'masked-user',
      counselTopic: 'Writing 집중 상담', status: 'new_inquiry',
    };
    const created = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('프로필학생', { student: payload })).expect(201)).body.student;
    expect(created).toMatchObject(payload);
    expect((await http.get(`/api/students/${created.id}`).set(asAdmin()).expect(200)).body).toMatchObject(payload);

    await http.post('/api/students').set(asAdmin()).send(studentAggregateBody('날짜오류', { student: { birthDate: '2012-02-30' } })).expect(400);
    await http.post('/api/students').set(asAdmin()).send(studentAggregateBody('성별오류', { student: { gender: 'unknown' as never } })).expect(400);
    await http.post('/api/students').set(asAdmin()).send(studentAggregateBody('상태오류', { student: { status: 'active' as never } })).expect(400);
  });

  it('Kinder는 grade=0으로 저장하고 생년월일·학년 누락 신규 입력은 400으로 차단한다', async () => {
    const kinder = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('킨더학생', { student: { birthDate: birthDateForAge(5), grade: 0 } })).expect(201)).body.student;
    expect(kinder).toMatchObject({ birthDate: birthDateForAge(5), grade: 0 });

    const missingBirth = studentAggregateBody('생일누락') as unknown as { student: Record<string, unknown> };
    delete missingBirth.student.birthDate;
    await http.post('/api/students').set(asAdmin()).send(missingBirth).expect(400);

    const missingGrade = studentAggregateBody('학년누락') as unknown as { student: Record<string, unknown> };
    delete missingGrade.student.grade;
    await http.post('/api/students').set(asAdmin()).send(missingGrade).expect(400);

    await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('킨더저연령', { student: { birthDate: birthDateForAge(2), grade: 0 } })).expect(400);
    await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('킨더고연령', { student: { birthDate: birthDateForAge(8), grade: 0 } })).expect(400);
    await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('G13학생', { student: { grade: 13 } })).expect(201);
    await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('G14학생', { student: { grade: 14 } })).expect(400);
  });

  it('학생 수정도 최종 grade/birthDate 조합을 재검증하고 Kinder 경계 밖 변경을 거부한다', async () => {
    const created = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('킨더수정학생', { student: { birthDate: birthDateForAge(5), grade: 0 } })).expect(201)).body.student;
    await http.patch(`/api/students/${created.id}`).set(asAdmin()).send({ birthDate: birthDateForAge(16) }).expect(400);
    await http.patch(`/api/students/${created.id}`).set(asAdmin()).send({ grade: 8 }).expect(200);
    const updated = (await http.patch(`/api/students/${created.id}`).set(asAdmin())
      .send({ birthDate: birthDateForAge(16) }).expect(200)).body;
    expect(updated).toMatchObject({ grade: 8, birthDate: birthDateForAge(16) });
  });

  it('학생 PII는 감사 diff에서 원문 대신 마스킹된다', () => {
    const masked = app.get(AuditService).maskContactPii({
      phone: { before: '010-1111-2222', after: '010-3333-4444' },
      birthDate: { after: '2012-07-21' }, address: { after: '서울시' },
      addressDetail: { after: '101호' }, kakaoId: { after: 'student-kakao' },
      name: { after: '학생명' },
    });
    expect(masked).toEqual({
      phone: { before: '[masked]', after: '[masked]' },
      birthDate: { after: '[masked]' }, address: { after: '[masked]' },
      addressDetail: { after: '[masked]' }, kakaoId: { after: '[masked]' },
      name: { after: '학생명' },
    });
  });

  it('가족 관계를 canonical pair로 CRUD하고 자기연결·중복·nested IDOR를 차단하며 전 변경을 감사한다', async () => {
    const first = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('가족학생A')).expect(201)).body.student;
    const second = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('가족학생B')).expect(201)).body.student;

    await http.post(`/api/students/${first.id}/family-relations`).set(asAdmin())
      .send({ relatedStudentId: first.id, relationType: 'sibling' }).expect(400);
    const relation = (await http.post(`/api/students/${second.id}/family-relations`).set(asAdmin())
      .send({ relatedStudentId: first.id, relationType: 'other', relationLabel: '사촌' }).expect(201)).body;
    expect(relation).toMatchObject({
      studentIdA: Math.min(first.id, second.id), studentIdB: Math.max(first.id, second.id),
      relationType: 'other', relationLabel: '사촌',
    });
    await http.post(`/api/students/${first.id}/family-relations`).set(asAdmin())
      .send({ relatedStudentId: second.id, relationType: 'sibling' }).expect(409);

    const aggregate = (await http.get(`/api/students/${first.id}/aggregate`).set(asAdmin()).expect(200)).body;
    expect(aggregate.familyRelations.map((row: { id: number }) => row.id)).toContain(relation.id);
    await http.patch(`/api/students/${first.id}/family-relations/${relation.id}`).set(asAdmin())
      .send({ relationType: 'sibling' }).expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ relationType: 'sibling', relationLabel: null }));
    await http.patch(`/api/students/99999/family-relations/${relation.id}`).set(asAdmin())
      .send({ relationType: 'sibling' }).expect(404);
    await http.delete(`/api/students/${second.id}/family-relations/${relation.id}`).set(asAdmin()).expect(200);

    const audit = (await http.get(`/api/audit?entity=student_family_relations&entityId=${relation.id}`).set(asAdmin()).expect(200)).body;
    expect(audit.map((row: { action: string }) => row.action)).toEqual(expect.arrayContaining(['create', 'update', 'delete']));
    expect(audit.every((row: { actorId: number }) => row.actorId === 3)).toBe(true);
  });

  it('강사 학생 aggregate는 core만 반환하고 가족/학사 전용 URL 직접 접근은 403이다', async () => {
    const asInstructor = { Authorization: `Bearer ${INSTRUCTOR}` };
    const aggregate = (await http.get('/api/students/1/aggregate').set(asInstructor).expect(200)).body;
    expect(aggregate.student).toBeDefined();
    expect(aggregate.familyRelations).toBeUndefined();
    expect(aggregate.academicHistories).toBeUndefined();
    await http.get('/api/students/1/family-relations').set(asInstructor).expect(403);
    await http.post('/api/students/1/family-relations').set(asInstructor)
      .send({ relatedStudentId: 2, relationType: 'sibling' }).expect(403);
    await http.get('/api/students/1/academic-histories').set(asInstructor).expect(403);
    await http.post('/api/students/1/academic-histories').set(asInstructor)
      .send({ grade: 1, schoolName: 'x', startedOn: '2020-01-01' }).expect(403);
  });

  it('과거·현재·미래 학교/학년 이력을 CRUD하고 overlap·actor spoof를 막으며 현재 profile을 동기화한다', async () => {
    const student = (await http.post('/api/students').set(asAdmin())
      .send(studentAggregateBody('학사이력학생', { student: { grade: 11, schoolName: '기존학교' } })).expect(201)).body.student;
    const initial = (await http.get(`/api/students/${student.id}/aggregate`).set(asAdmin()).expect(200)).body.academicHistories[0];
    const history = (await http.patch(`/api/students/${student.id}/academic-histories/${initial.id}`).set(asAdmin()).send({
      grade: 13, schoolName: '현재학교', startedOn: '2026-01-01', endedOn: null,
    }).expect(200)).body;
    expect((await http.get(`/api/students/${student.id}`).set(asAdmin()).expect(200)).body)
      .toMatchObject({ grade: 13, schoolName: '현재학교' });

    await http.post(`/api/students/${student.id}/academic-histories`).set(asAdmin()).send({
      grade: 12, schoolName: '겹침학교', startedOn: '2026-06-01', endedOn: '2027-01-01',
    }).expect(409);
    await http.patch(`/api/students/${student.id}/academic-histories/${history.id}`).set(asAdmin())
      .send({ changedBy: 999, grade: 12 }).expect(400);
    const updated = (await http.patch(`/api/students/${student.id}/academic-histories/${history.id}`).set(asAdmin())
      .send({ grade: 12, schoolName: '수정학교' }).expect(200)).body;
    expect(updated).toMatchObject({ grade: 12, schoolName: '수정학교', changedBy: 3 });
    expect((await http.get(`/api/students/${student.id}/aggregate`).set(asAdmin()).expect(200)).body)
      .toMatchObject({ student: { grade: 12, schoolName: '수정학교' } });

    await http.delete(`/api/students/${student.id}/academic-histories/${history.id}`).set(asAdmin()).expect(200);
    const audit = (await http.get(`/api/audit?entity=student_academic_histories&entityId=${history.id}`).set(asAdmin()).expect(200)).body;
    expect(audit.map((row: { action: string }) => row.action)).toEqual(expect.arrayContaining(['create', 'update', 'delete']));
  });
});
