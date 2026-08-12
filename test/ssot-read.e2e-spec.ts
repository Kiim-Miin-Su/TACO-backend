// [TBO-54 C2 2026-07-23] 2-instance read-after-write 실증(PG 전용) — TBO-50 §8 C2 완료 조건.
//  인스턴스 A의 write가 B의 목록/상세/aggregate/GraphQL에 **즉시** 반영되고, A의 soft delete가
//  B에서 즉시 사라져야 한다(종전: 부팅 hydrate 메모리라 재기동 전까지 B에 미반영/재노출).
//  실행: RUN_MONEY_RACE_E2E=1 DATABASE_URL=... (money-race와 같은 게이트 — 로컬 fresh DB 권장)
import { INestApplication } from '@nestjs/common';
import { config } from 'dotenv';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { completeSessionByAttendance, createTestApp, sudoAuthHeaders } from './setup-app';
import { PostgresCollectionStore } from '../src/database/postgres-collection.store';
import { USERS_SPEC } from '../src/database/calendar-asset-specs';
import { AuthService } from '../src/modules/auth/auth.service';
import { UsersService } from '../src/modules/users/users.service';
import { studentAggregateBody } from './fixtures/student-profile';

const enabled = process.env.RUN_MONEY_RACE_E2E === '1';
const describeDb = enabled ? describe : describe.skip;

type UserRow = { id: number; role: string; status: string; deletedAt?: string | null };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const openApps = new Set<INestApplication>();

describeDb('[TBO-54 C2] SSOT read-after-write — 2-instance PG (e2e)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let httpA: ReturnType<typeof request>;
  let httpB: ReturnType<typeof request>;
  let admin = '';
  let adminB = '';
  let ceoId = 0;
  const stamp = `${Date.now()}_${process.pid}`;

  beforeAll(async () => {
    config({ path: process.env.DOTENV_CONFIG_PATH ?? '.env.local', override: false });
    if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
      throw new Error('RUN_MONEY_RACE_E2E=1은 DATABASE_URL이 필요합니다(로컬 fresh DB 권장).');
    }
    process.env.TEST_BUSINESS_FIXTURES = '0';
    appA = await createTestApp();
    openApps.add(appA);
    const users = appA.get(UsersService).findAll() as unknown as UserRow[];
    const activeUsers = users.filter((row) => row.status === 'active' && row.deletedAt == null);
    const ceo = activeUsers.find((row) => row.role === 'super_admin');
    if (ceo) ceoId = ceo.id;
    else if (activeUsers.length > 0) throw new Error('활성 계정이 있는 DB에는 bootstrap하지 않습니다.');
    else {
      const passwordHash = await bcrypt.hash(`Ssot!${stamp}`, 12);
      const row = await appA.get(PostgresCollectionStore).insert(USERS_SPEC, {
        webId: `ssot_ceo_${stamp}`, name: `SSOT 대표 ${stamp}`, englishName: `Ssot Ceo ${stamp}`, email: `ssot_${stamp}@qa.local`,
        role: 'super_admin', status: 'active', passwordHash, emailVerified: true,
      } as never);
      ceoId = (row as { id: number }).id;
    }
    appB = await createTestApp(); // B는 A의 시드/생성물을 메모리에 갖지 않는다
    openApps.add(appB);
    httpA = request(appA.getHttpServer());
    httpB = request(appB.getHttpServer());
    admin = appA.get(AuthService).sign({ sub: ceoId, name: 'SSOT', englishName: 'Ssot Ceo', roles: ['super_admin'], authVersion: 1, mustChangePassword: false });
    adminB = appB.get(AuthService).sign({ sub: ceoId, name: 'SSOT', englishName: 'Ssot Ceo', roles: ['super_admin'], authVersion: 1, mustChangePassword: false });
  }, 120_000);

  afterAll(async () => { for (const app of openApps) await app.close(); }, 60_000);

  it('학생: A 생성 → B 목록·상세·aggregate 즉시 노출, A 삭제 → B에서 즉시 소멸', async () => {
    const created = (await httpA.post('/api/students').set(auth(admin))
      .send(studentAggregateBody(`SSOT학생${String(Date.now()).slice(-7)}`, {
        interests: [{ customLabel: 'SSOT 희망 A', priority: 1 }, { customLabel: 'SSOT 희망 B', priority: 2 }],
      })).expect(201)).body.student;
    const listB = (await httpB.get('/api/students').set(auth(adminB)).expect(200)).body as Array<{ id: number }>;
    expect(listB.some((row) => row.id === created.id)).toBe(true); // 종전: B 메모리에 없어 미노출
    const detailB = (await httpB.get(`/api/students/${created.id}`).set(auth(adminB)).expect(200)).body;
    expect(detailB.name).toBe(created.name);
    const aggregateB = (await httpB.get(`/api/students/${created.id}/aggregate`).set(auth(adminB)).expect(200)).body;
    expect(aggregateB.interests).toHaveLength(2); // aggregate 구성 표도 DB 조립

    await httpA.delete(`/api/students/${created.id}`).set(auth(admin)).expect(200);
    await httpB.get(`/api/students/${created.id}`).set(auth(adminB)).expect(404); // 종전: 삭제 학생 재노출
    const listAfter = (await httpB.get('/api/students').set(auth(adminB)).expect(200)).body as Array<{ id: number }>;
    expect(listAfter.some((row) => row.id === created.id)).toBe(false);
  });

  it('카탈로그·수강·결제·원장·이벤트·강의실·로드맵: A write → B read 즉시 일치', async () => {
    // 강의실
    const room = (await httpA.post('/api/rooms').set(auth(admin))
      .send({ name: `SSOT 강의실 ${stamp}`, capacity: 3, isActive: true }).expect(201)).body;
    expect(((await httpB.get('/api/rooms').set(auth(adminB)).expect(200)).body as Array<{ id: number }>)
      .some((row) => row.id === room.id)).toBe(true);
    // 이벤트
    const event = (await httpA.post('/api/events').set(auth(admin))
      .send({ title: `SSOT 이벤트 ${stamp}`, type: 'notice', startDate: '2099-01-01', endDate: '2099-01-02' }).expect(201)).body;
    expect(((await httpB.get('/api/events').set(auth(adminB)).expect(200)).body as Array<{ id: number }>)
      .some((row) => row.id === event.id)).toBe(true);
    // 카탈로그(과목·코스) + 학생·수강
    const instructorId = Number((await httpA.post('/api/users/instructors').set(auth(admin)).send({
      webId: `ssot_inst_${stamp}`, name: `SSOT 강사 ${stamp}`, englishName: `Ssot Instructor ${stamp}`, password: `Ssot!${stamp}x`,
      defaultHourlyRate: 40000, canTeachKinder: false, countryCode: 'KR', timeZone: 'Asia/Seoul',
    }).expect(201)).body.id);
    const subjectId = Number((await httpA.post('/api/subjects').set(auth(admin))
      .send({ code: `ssot_${stamp}`, name: `SSOT 과목 ${stamp}` }).expect(201)).body.id);
    const courseId = Number((await httpA.post('/api/courses').set(auth(admin)).send({
      name: `SSOT 코스 ${stamp}`, subjectId, instructorId, price: 200000, isKinder: false,
    }).expect(201)).body.id);
    const studentId = Number((await httpA.post('/api/students').set(auth(admin))
      .send(studentAggregateBody(`SSOT수강${String(Date.now()).slice(-7)}`, {
        interests: [{ customLabel: 'SSOT-A', priority: 1 }, { customLabel: 'SSOT-B', priority: 2 }],
      })).expect(201)).body.student.id);
    const enrollment = (await httpA.post('/api/enrollments').set(auth(admin))
      .send({ studentId, courseId, totalSessions: 4 }).expect(201)).body;
    expect(((await httpB.get('/api/enrollments').set(auth(adminB)).expect(200)).body as Array<{ id: number }>)
      .some((row) => row.id === enrollment.id)).toBe(true);
    const enrollmentDetailB = (await httpB.get(`/api/enrollments/${enrollment.id}`).set(auth(adminB)).expect(200)).body;
    expect(enrollmentDetailB.studentId).toBe(studentId);
    // 결제 → 수납(B에서!) → 원장이 A/B 어디서든 동일
    const payment = (await httpA.post('/api/payments').set(auth(admin))
      .send({ studentId, enrollmentId: enrollment.id, amount: 150000 }).expect(201)).body;
    const paymentB = (await httpB.get(`/api/payments/${payment.id}`).set(auth(adminB)).expect(200)).body;
    expect(paymentB.amount).toBe(150000);
    await httpB.post(`/api/payments/${payment.id}/pay`).set(sudoAuthHeaders(appB, adminB)).expect(201); // 타 인스턴스 결재
    const ledgerA = (await httpA.get('/api/transactions').set(auth(admin)).expect(200)).body as Array<{ paymentId?: number; amount: number }>;
    expect(ledgerA.filter((tx) => tx.paymentId === payment.id)).toHaveLength(1); // A도 즉시 원장 확인
    // 로드맵
    const roadmap = (await httpA.post('/api/roadmaps').set(auth(admin))
      .send({ title: `SSOT 로드맵 ${stamp}`, courseIds: [courseId] }).expect(201)).body;
    const roadmapB = (await httpB.get(`/api/roadmaps/${roadmap.id}`).set(auth(adminB)).expect(200)).body;
    expect(roadmapB.courses.map((c: { courseId: number }) => c.courseId)).toEqual([courseId]);
  });

  // [TBO-56 C2b] 정산 읽기 8종 DB 전환 실증 — 종전엔 B 메모리에 A의 세션·보고서가 없어
  //  preview 0원·readiness 공백·목록 미노출(TBO-55 감사 "payouts GET 8종 전부 메모리").
  it('정산: A의 세션·승인 보고서·정산서가 B의 preview/readiness/목록/단건에 즉시 반영', async () => {
    // A: 강사·코스(시급 60,000)·학생·수강 — 적격 입력 전부 API로 생성
    const instructorId = Number((await httpA.post('/api/users/instructors').set(auth(admin)).send({
      webId: `ssot_pay_inst_${stamp}`, name: `SSOT 정산강사 ${stamp}`, englishName: `Ssot Pay Instructor ${stamp}`, password: `Ssot!${stamp}p`,
      defaultHourlyRate: 60000, canTeachKinder: false, countryCode: 'KR', timeZone: 'Asia/Seoul',
    }).expect(201)).body.id);
    const subjectId = Number((await httpA.post('/api/subjects').set(auth(admin))
      .send({ code: `ssot_pay_${stamp}`, name: `SSOT 정산과목 ${stamp}` }).expect(201)).body.id);
    const courseId = Number((await httpA.post('/api/courses').set(auth(admin)).send({
      name: `SSOT 정산코스 ${stamp}`, subjectId, instructorId, price: 300000, hourlyRate: 60000, isKinder: false,
    }).expect(201)).body.id);
    const studentId = Number((await httpA.post('/api/students').set(auth(admin))
      .send(studentAggregateBody(`SSOT정산${String(Date.now()).slice(-7)}`, {
        interests: [{ customLabel: 'SSOT-P1', priority: 1 }, { customLabel: 'SSOT-P2', priority: 2 }],
      })).expect(201)).body.student.id);
    await httpA.post('/api/enrollments').set(auth(admin)).send({ studentId, courseId, totalSessions: 4 }).expect(201);
    // A: 세션 2개 — ses1 held+보고서 승인(적격), ses2 held+보고서 없음(readiness 이슈)
    const makeSession = async (startTime: string, durationMinutes: number) =>
      Number((await httpA.post('/api/schedule').set(auth(admin)).send({
        courseId, instructorId, studentIds: [studentId], sessionDate: '2025-03-03', startTime, durationMinutes, force: true,
      }).expect(201)).body.row.id);
    const ses1 = await makeSession('10:00', 90);
    const ses2 = await makeSession('13:00', 60);
    for (const id of [ses1, ses2]) {
      await completeSessionByAttendance(httpA, auth(admin), id, [studentId]);
    }
    const reportId = Number((await httpA.post('/api/reports').set(auth(admin))
      .send({ sessionId: ses1, studentId, content: 'SSOT 정산 보고서' }).expect(201)).body.id);
    await httpA.post(`/api/reports/${reportId}/approve`).set(auth(admin)).expect(201);
    // B: preview — 입력 표 재수화 산정(measureFresh)이 A의 held+승인 세션만 계상
    const previewB = (await httpB.get(`/api/payouts/preview?instructorId=${instructorId}&from=2025-03-01&to=2025-03-31`)
      .set(auth(adminB)).expect(200)).body;
    expect(previewB.sessionCount).toBe(1); // ses2는 보고서 미승인 — 제외
    expect(previewB.computedAmount).toBe(90000); // 90분 × 60,000원/h
    // B: readiness — A의 미비 세션(ses2 보고서 없음)이 즉시 이슈로, ses1은 적격으로
    const readinessB = (await httpB.get(`/api/payouts/readiness?instructorId=${instructorId}&from=2025-03-01&to=2025-03-31`)
      .set(auth(adminB)).expect(200)).body;
    expect(readinessB.eligibleSessionIds).toContain(ses1);
    expect(readinessB.issues.some((issue: { sessionId: number; type: string }) =>
      issue.sessionId === ses2 && issue.type === 'report_missing')).toBe(true);
    // A: 정산서 생성 → B 목록·단건 즉시(DB 권위 READ)
    const payout = (await httpA.post('/api/payouts/generate').set(auth(admin))
      .send({ instructorId, from: '2025-03-01', to: '2025-03-31' }).expect(201)).body;
    const listB = (await httpB.get('/api/payouts').set(auth(adminB)).expect(200)).body as Array<{ id: number }>;
    expect(listB.some((row) => row.id === payout.id)).toBe(true); // 종전: B 메모리에 없어 미노출
    const detailB = (await httpB.get(`/api/payouts/${payout.id}`).set(auth(adminB)).expect(200)).body;
    expect(detailB.computedAmount).toBe(90000);
    expect(detailB.instructorId).toBe(instructorId);
  });

  // [TBO-56 C2b] 출결 GET/PUT DB 전환 실증 — 종전 PUT은 메모리 판별+lock 없음이라
  //  교차 인스턴스에서 update 대신 insert 시도 → unique 500(TBO-55 감사 최상위 원자성 위험).
  it('출결: A 기록 → B 조회 즉시, B upsert가 갱신 1행(교차 인스턴스 insert 중복 없음), 동시 upsert 직렬화', async () => {
    const studentId = Number((await httpA.post('/api/students').set(auth(admin))
      .send(studentAggregateBody(`SSOT출결${String(Date.now()).slice(-7)}`, {
        interests: [{ customLabel: 'SSOT-A1', priority: 1 }, { customLabel: 'SSOT-A2', priority: 2 }],
      })).expect(201)).body.student.id);
    const instructorId = Number((await httpA.post('/api/users/instructors').set(auth(admin)).send({
      webId: `ssot_att_inst_${stamp}`, name: `SSOT 출결강사 ${stamp}`, englishName: `Ssot Attendance Instructor ${stamp}`, password: `Ssot!${stamp}a`,
      defaultHourlyRate: 40000, canTeachKinder: false, countryCode: 'KR', timeZone: 'Asia/Seoul',
    }).expect(201)).body.id);
    const subjectId = Number((await httpA.post('/api/subjects').set(auth(admin))
      .send({ code: `ssot_att_${stamp}`, name: `SSOT 출결과목 ${stamp}` }).expect(201)).body.id);
    const courseId = Number((await httpA.post('/api/courses').set(auth(admin)).send({
      name: `SSOT 출결코스 ${stamp}`, subjectId, instructorId, price: 100000, isKinder: false,
    }).expect(201)).body.id);
    await httpA.post('/api/enrollments').set(auth(admin)).send({ studentId, courseId, totalSessions: 4 }).expect(201);
    const sessionId = Number((await httpA.post('/api/schedule').set(auth(admin)).send({
      courseId, instructorId, studentIds: [studentId], sessionDate: '2099-03-05', startTime: '10:00', durationMinutes: 60, force: true,
    }).expect(201)).body.row.id);
    // A 기록 → B 조회 즉시(종전: B 메모리에 행 없어 공백)
    await httpA.put('/api/attendance').set(auth(admin)).send({ sessionId, studentId, status: 'present' }).expect(200);
    const rowsB = (await httpB.get(`/api/attendance?sessionId=${sessionId}`).set(auth(adminB)).expect(200)).body as Array<{ studentId: number; status: string }>;
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]).toMatchObject({ studentId, status: 'present' });
    // B upsert = 기존 행 DB 판별 → **갱신**(종전: B 메모리에 행 없어 insert 시도 → unique 500)
    await httpB.put('/api/attendance').set(auth(adminB)).send({ sessionId, studentId, status: 'late' }).expect(200);
    const afterUpdate = (await httpA.get(`/api/attendance?sessionId=${sessionId}`).set(auth(admin)).expect(200)).body as Array<{ status: string }>;
    expect(afterUpdate).toHaveLength(1); // 중복 행 0
    expect(afterUpdate[0].status).toBe('late');
    // 동시 upsert(A vs B) — session advisory lock으로 직렬화, 둘 다 성공·최종 1행(500 경로 제거)
    const [ra, rb] = await Promise.all([
      httpA.put('/api/attendance').set(auth(admin)).send({ sessionId, studentId, status: 'absent' }),
      httpB.put('/api/attendance').set(auth(adminB)).send({ sessionId, studentId, status: 'excused' }),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const final = (await httpB.get(`/api/attendance?sessionId=${sessionId}`).set(auth(adminB)).expect(200)).body as Array<{ status: string }>;
    expect(final).toHaveLength(1);
    expect(['absent', 'excused']).toContain(final[0].status);
  });

  // [TBO-56 C2b] students 하위 조인 3종+interests DB 전환 실증 — 종전 family aggregate는
  //  메모리 미러 조립이라 A의 관계 연결이 B에 미반영(TBO-55 감사 "TBO-30G 조인이 실제로는 메모리").
  it('가족·희망코스: A의 관계 연결이 B의 family aggregate/relations/interests에 즉시 반영', async () => {
    const make = async (label: string) => Number((await httpA.post('/api/students').set(auth(admin))
      .send(studentAggregateBody(`${label}${String(Date.now()).slice(-6)}`, {
        interests: [{ customLabel: `${label} 희망1`, priority: 1 }, { customLabel: `${label} 희망2`, priority: 2 }],
      })).expect(201)).body.student.id);
    const aId = await make('SSOT형');
    const bId = await make('SSOT동생');
    const relationId = Number((await httpA.post(`/api/students/${bId}/family-relations`).set(auth(admin))
      .send({ relatedStudentId: aId, relationType: 'sibling' }).expect(201)).body.id);
    // B: relations·aggregate 즉시(종전: B 메모리에 관계 행 없어 공백/미포함)
    const relationsB = (await httpB.get(`/api/students/${bId}/family-relations`).set(auth(adminB)).expect(200)).body as Array<{ id: number }>;
    expect(relationsB.some((row) => row.id === relationId)).toBe(true);
    const familyB = (await httpB.get(`/api/students/${bId}/family`).set(auth(adminB)).expect(200)).body as {
      studentId: number; members: Array<{ relationId: number; student: { id: number } }>;
    };
    expect(familyB.studentId).toBe(bId);
    const member = familyB.members.find((row) => row.student.id === aId); // members = 관계 상대(자기 제외)
    expect(member?.relationId).toBe(relationId); // 같은 관계 행에서 파생(사본 아님)
    // B: interests — 학생 생성 시 입력 2건이 DB 조립로 즉시
    const interestsB = (await httpB.get(`/api/students/${aId}/interests`).set(auth(adminB)).expect(200)).body as Array<{ priority: number }>;
    expect(interestsB).toHaveLength(2);
    expect(interestsB.map((row) => row.priority)).toEqual([1, 2]);
  });

  it('GraphQL revenueReport: A 수납이 B 인스턴스 집계에 즉시 반영(P0-4 DB snapshot)', async () => {
    const studentId = Number((await httpA.post('/api/students').set(auth(admin))
      .send(studentAggregateBody(`SSOT매출${String(Date.now()).slice(-7)}`, {
        interests: [{ customLabel: 'SSOT-R1', priority: 1 }, { customLabel: 'SSOT-R2', priority: 2 }],
      })).expect(201)).body.student.id);
    const payment = (await httpA.post('/api/payments').set(auth(admin))
      .send({ studentId, amount: 77000 }).expect(201)).body;
    await httpA.post(`/api/payments/${payment.id}/pay`).set(sudoAuthHeaders(appA, admin)).expect(201);
    const query = `query { revenueReport { realizedTotal byStudent { key amount } } }`;
    const [ga, gb] = await Promise.all([
      httpA.post('/api/graphql').set(auth(admin)).send({ query }).expect(201),
      httpB.post('/api/graphql').set(auth(adminB)).send({ query }).expect(201),
    ]);
    const totalA = ga.body.data.revenueReport.realizedTotal;
    const totalB = gb.body.data.revenueReport.realizedTotal;
    expect(totalB).toBe(totalA); // 두 인스턴스 동일 집계(종전: B 메모리 스냅샷이라 미반영)
    expect(totalB).toBeGreaterThanOrEqual(77000);
  });
});
