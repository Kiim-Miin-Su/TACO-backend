import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// ─────────────────────────────────────────────────────────────
// [자산화 점검 2026-07-02] 전 도메인 "쓰기 → in-memory 저장" 전수 검증.
//  모든 운영 데이터(사내 자산)가 InMemoryDatabase 컬렉션에 기록되고 재조회되는지 API로 확인한다.
//  특히 users(직원 계정)는 이전에 서비스 로컬 배열이라 자산 밖이었음 → db 이관 회귀 가드.
//  (payouts·reports 승인·정산 흐름은 full-flow/payouts e2e가 심층 검증 — 여기선 저장 자체에 집중)
// ─────────────────────────────────────────────────────────────
describe('Asset persistence sweep (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  const listLen = async (path: string) => ((await http.get(path).expect(200)).body as unknown[]).length;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('users: 가입 신청이 컬렉션에 저장되고(pending) 승인 상태 변화도 기록된다', async () => {
    const before = await listLen('/api/users');
    const res = await http.post('/api/auth/signup')
      .send({ webId: 'asset_tester', name: '자산테스터', email: 'asset@tnacademy.test', password: 'password12', role: 'instructor' })
      .expect(201);
    const id = res.body.account?.id ?? res.body.id;
    expect(await listLen('/api/users')).toBe(before + 1);
    const all = (await http.get('/api/users').expect(200)).body;
    const saved = all.find((a: { webId: string }) => a.webId === 'asset_tester');
    expect(saved).toMatchObject({ status: 'pending', emailVerified: false, role: 'instructor' });
    expect(saved.passwordHash).toBeUndefined(); // 안전 필드만 노출
    expect(saved.id).toBe(id);
  });

  it('catalog·명단: subjects/courses/rooms/students/enrollments/parents(+관계) 생성이 저장된다', async () => {
    const subj = (await http.post('/api/subjects').set(asAdmin()).send({ code: 'sci', name: '과학' }).expect(201)).body;
    const course = (await http.post('/api/courses').set(asAdmin())
      .send({ name: '과학 정규', subjectId: subj.id, instructorId: 1, price: 300000, hourlyRate: 40000 }).expect(201)).body;
    const room = (await http.post('/api/rooms').set(asAdmin()).send({ name: 'C301', capacity: 6, isActive: true }).expect(201)).body;
    const student = (await http.post('/api/students').set(asAdmin()).send({ name: '자산학생', grade: 9, status: 'active' }).expect(201)).body;
    const enr = (await http.post('/api/enrollments').set(asAdmin())
      .send({ studentId: student.id, courseId: course.id, totalSessions: 8 }).expect(201)).body;
    // POST /parents = 보호자 생성 + 학생 연결 동시(DTO가 studentId 필수)
    const parentRes = (await http.post('/api/parents').set(asAdmin())
      .send({ name: '자산보호자', phone: '010-0000-0000', studentId: student.id, relation: 'mother', isPrimary: true }).expect(201)).body;
    const parentId = parentRes.parent?.id ?? parentRes.id;

    // 재조회로 저장 확인(각 컬렉션)
    expect((await http.get('/api/subjects').expect(200)).body.some((x: { id: number }) => x.id === subj.id)).toBe(true);
    expect((await http.get('/api/courses').expect(200)).body.some((x: { id: number }) => x.id === course.id)).toBe(true);
    expect((await http.get('/api/rooms').expect(200)).body.some((x: { id: number }) => x.id === room.id)).toBe(true);
    expect((await http.get('/api/students').expect(200)).body.some((x: { id: number }) => x.id === student.id)).toBe(true);
    expect((await http.get('/api/enrollments').expect(200)).body.some((x: { id: number }) => x.id === enr.id)).toBe(true);
    expect((await http.get('/api/parents/relations').expect(200)).body
      .some((x: { parentId: number; studentId: number }) => x.parentId === parentId && x.studentId === student.id)).toBe(true);

    // 파생 무결성: 신규 코스·수강이 스케줄 자원/코호트 유니버스에 반영(감사 A의 단일 소스 확인)
    const resources = (await http.get('/api/schedule/resources').expect(200)).body;
    expect(resources.courses.some((c: { id: number }) => c.id === course.id)).toBe(true);
    expect(resources.students.some((s: { id: number }) => s.id === student.id)).toBe(true);
  });

  it('운영 데이터: schedule/availability/attendance/counsel(+round)/reports/events 생성이 저장된다', async () => {
    const ses = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-01-04', startTime: '10:00', endTime: '11:00' }).expect(201)).body.row;
    await http.put('/api/availability').set(asAdmin())
      .send({ ownerType: 'instructor', ownerId: 1, kind: 'unavailable', weekday: 0, startTime: '07:00', endTime: '08:00' }).expect(200);
    await http.put('/api/attendance').set(asAdmin()).send({ sessionId: ses.id, studentId: 1, status: 'present' }).expect(200);
    const counsel = (await http.post('/api/counsel').set(asAdmin())
      .send({ applicantName: '자산상담', applicantPhone: '010-1111-2222', source: 'manual' }).expect(201)).body;
    await http.post(`/api/counsel/${counsel.id}/rounds`).set(asAdmin())
      .send({ summary: '1차 상담 기록', nextContactAt: '2099-01-06' }).expect(201);
    const report = (await http.post('/api/reports').set(asAdmin())
      .send({ sessionId: ses.id, studentId: 1, instructorId: ses.instructorId, content: '자산 리포트', status: 'submitted' }).expect(201)).body;
    const event = (await http.post('/api/events').set(asAdmin())
      .send({ title: '자산 이벤트', type: 'event', startDate: '2099-02-01', endDate: '2099-02-01', priority: 'normal' }).expect(201)).body;

    expect((await http.get(`/api/schedule?from=2099-01-01&to=2099-01-31`).expect(200)).body.some((x: { id: number }) => x.id === ses.id)).toBe(true);
    expect((await http.get('/api/availability?ownerType=instructor&ownerId=1').expect(200)).body
      .some((b: { weekday: number; startTime: string }) => b.weekday === 0 && b.startTime === '07:00')).toBe(true);
    expect((await http.get('/api/attendance').set(asAdmin()).expect(200)).body
      .some((a: { sessionId: number; studentId: number }) => a.sessionId === ses.id && a.studentId === 1)).toBe(true);
    expect((await http.get('/api/counsel').expect(200)).body.some((c: { id: number }) => c.id === counsel.id)).toBe(true);
    expect((await http.get('/api/counsel/rounds').expect(200)).body.some((r: { counselFormId: number }) => r.counselFormId === counsel.id)).toBe(true);
    expect((await http.get(`/api/reports?sessionId=${ses.id}`).expect(200)).body.some((r: { id: number }) => r.id === report.id)).toBe(true);
    expect((await http.get('/api/events').expect(200)).body.some((e: { id: number }) => e.id === event.id)).toBe(true);
  });

  it('[감사 2026-07-02] 입력 가드 회귀: country 형식·enrollment FK·duration/amount 상한 = 400', async () => {
    // H1: country는 ISO alpha-2 대문자 2자만 — 임의 문자열/소문자/1자 거부
    await http.post('/api/students').set(asAdmin()).send({ name: '가드학생', country: 'usa' }).expect(400);
    await http.post('/api/students').set(asAdmin()).send({ name: '가드학생', country: 'X' }).expect(400);
    const ok = (await http.post('/api/students').set(asAdmin()).send({ name: '가드학생', country: 'US' }).expect(201)).body;
    expect(ok.country).toBe('US');
    // H3: enrollments FK — 존재하지 않는 학생/코스 거부(유령 코호트 방지)
    await http.post('/api/enrollments').set(asAdmin()).send({ studentId: 99999, courseId: 10 }).expect(400);
    await http.post('/api/enrollments').set(asAdmin()).send({ studentId: ok.id, courseId: 99999 }).expect(400);
    // H4: durationMinutes 상한 8h — 시급 계산 오염 방지
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-05-01', startTime: '10:00', durationMinutes: 999999 }).expect(400);
    // H5: amount 상한 1억
    await http.post('/api/payments').set(asAdmin())
      .send({ studentId: 1, courseId: 10, amount: 999_999_999_999, dueAt: '2099-05-01' }).expect(400);
    await http.post('/api/expenses').set(asAdmin())
      .send({ title: '가드 지출', amount: 999_999_999_999, category: 'supplies', spentAt: '2099-05-01' }).expect(400);
    // [자정 크로스] KST 저장 세션은 당일 오후→익일 오전으로 넘어갈 수 없다(설계상 거부 — 단일 날짜 세션만).
    //  ① endTime < startTime(23:00→01:00) = "종료가 시작보다 빠름" 400
    //  ② durationMinutes로 24:00 초과(23:00+120분) = addMinutes 범위 가드 400
    //  해외 학생용 자정 크로스 "표시"는 프론트 tz 변환의 24:00 클램프가 담당(저장은 항상 KST 단일 날짜).
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-05-02', startTime: '23:00', endTime: '01:00' }).expect(400);
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-05-02', startTime: '23:00', durationMinutes: 120 }).expect(400);
  });

  it('재무: payments(청구→수납)와 expenses(요청→승인)가 저장되고 원장(transactions)에 기록된다', async () => {
    const txBefore = await listLen('/api/transactions');
    const pay = (await http.post('/api/payments').set(asAdmin())
      .send({ studentId: 1, courseId: 10, amount: 111000, dueAt: '2099-03-01' }).expect(201)).body;
    await http.post(`/api/payments/${pay.id}/pay`).set(asAdmin()).send({ method: 'card' }).expect(201);
    const exp = (await http.post('/api/expenses').set(asAdmin())
      .send({ title: '자산 지출', amount: 5000, category: 'supplies', spentAt: '2099-03-02' }).expect(201)).body;
    await http.post(`/api/expenses/${exp.id}/approve`).set(asAdmin()).expect(201);

    expect((await http.get('/api/payments').expect(200)).body.some((x: { id: number }) => x.id === pay.id)).toBe(true);
    expect((await http.get('/api/expenses').expect(200)).body
      .find((x: { id: number }) => x.id === exp.id)?.status).toBe('approved');
    // 수납 입금 + 지출 출금 = 원장 2건 이상 증가
    expect(await listLen('/api/transactions')).toBeGreaterThanOrEqual(txBefore + 2);

    // [H1/H2 회귀] 중복 수납·재승인은 400 — 원장이 더 늘지 않는다(이중 기록 방지)
    const txAfter = await listLen('/api/transactions');
    await http.post(`/api/payments/${pay.id}/pay`).set(asAdmin()).send({ method: 'card' }).expect(400);
    await http.post(`/api/expenses/${exp.id}/approve`).set(asAdmin()).expect(400);
    await http.post(`/api/expenses/${exp.id}/reject`).set(asAdmin()).expect(400); // approved 반려 금지(원장 정합)
    expect(await listLen('/api/transactions')).toBe(txAfter);
  });
});
