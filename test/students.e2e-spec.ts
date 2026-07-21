import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
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
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
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

  it('DELETE 없는 학생 → 404', async () => {
    await http.delete('/api/students/99999').set(asAdmin()).expect(404);
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
});
