// [TBO-79 D1~D5 2026-07-30] 소급 재해석·TOCTOU 회귀.
//
//  D1: 명시 코호트가 없는 세션은 `participantIdsForSession`이 매번 **살아있는** 활성 수강으로
//      재해석했다. 그래서 수강을 취소하면 이미 끝난 회차의 참가자 집합이 소급해서 바뀌고,
//      그 위에 얹힌 리포트 완결·정산 적격·출결 배지·무결성 검사가 함께 흔들렸다.
//      → held 전이 시점에 참가자를 확정(freeze)한다.
//  D4: 대표 전용 출결 정책이 동시 비대표 요청에서도 fail-closed인지 확인한다.
//  D5: 권한 코드의 fail-open 기본값(actor 미상 = 전체 반환)을 fail-closed로 뒤집었다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mondayISO, addDaysISO, sudoAuthHeaders } from './setup-app';
import { InMemoryDatabase } from '../src/database/in-memory.database';

jest.setTimeout(20000);

describe('[TBO-79] 소급 재해석·TOCTOU (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who: string) => sudoAuthHeaders(app, tokens[who]);
  const PAST = addDaysISO(mondayISO(), -42);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  it('D1 — 명시 코호트 없이 만든 회차도 held 전이 시 참가자가 확정된다', async () => {
    // studentIds 미지정 = 서버가 코스 활성 수강으로 스냅샷. 코스 10의 활성 수강은 학생 1·4.
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, sessionDate: PAST, startTime: '08:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number; studentIds?: number[] };
    expect(created.studentIds?.sort((a, b) => a - b)).toEqual([1, 4]);
  });

  it('D1 — 빈 코호트로 만든 회차는 held 전이가 참가자를 굳혀 수강 취소에도 과거가 보존된다', async () => {
    // 명시적 빈 배열 = "코호트 미지정"으로 저장돼 매번 살아있는 활성 수강으로 재해석되던 경로.
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [], sessionDate: PAST, startTime: '10:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number; studentIds?: number[] };
    // 응답 row는 파생 코호트를 채워 보여주므로 **저장된 값**을 직접 본다 — 여기가 비어 있는 게 결함의 조건이다.
    const storedOf = (id: number) => app.get(InMemoryDatabase)
      .findById<{ studentIds?: number[] }>('class_sessions', id)?.studentIds ?? [];
    expect(storedOf(created.id)).toEqual([]);

    // 참가자(활성 수강 1·4) 전원 출결 + 강사 출결 → held 자동 전이
    for (const studentId of [1, 4]) {
      await http.put('/api/attendance').set(as('admin'))
        .send({ sessionId: created.id, studentId, status: 'present' }).expect(200);
    }
    await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin'))
      .send({ status: 'present' }).expect(200);

    const held = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(held.status).toBe('held');
    // 확정된 코호트가 **저장**됐다 — 이게 이번 수정의 핵심이다(종전엔 계속 빈 배열이었다).
    expect(storedOf(created.id).map(Number).sort((a, b) => a - b)).toEqual([1, 4]);

    const beforeAttendance = (await http.get(`/api/attendance?sessionId=${created.id}`).set(as('manager')).expect(200)).body;
    const beforeRequirement = { attendanceRequired: held.attendanceRequired, missing: held.missingAttendance };

    // 학생 4의 코스 10 수강을 취소 — 종전엔 이 시점에 과거 회차의 참가자가 1명으로 줄었다.
    const enrollments = (await http.get('/api/enrollments?studentId=4').set(as('manager')).expect(200))
      .body as Array<{ id: number; courseId: number }>;
    const target = enrollments.find((row) => Number(row.courseId) === 10);
    expect(target).toBeDefined();
    await http.patch(`/api/enrollments/${target!.id}`).set(as('manager'))
      .send({ status: 'canceled', reason: 'TBO-79 D1 소급 재해석 회귀' }).expect(200);

    // 과거 증거는 그대로여야 한다(expected === after).
    const after = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(storedOf(created.id).map(Number).sort((a, b) => a - b)).toEqual([1, 4]);
    expect((after.studentIds as number[]).sort((a, b) => a - b)).toEqual([1, 4]);
    expect(after.status).toBe('held');
    expect(after.attendanceRequired).toBe(beforeRequirement.attendanceRequired);
    expect(after.missingAttendance).toEqual(beforeRequirement.missing);
    expect((await http.get(`/api/attendance?sessionId=${created.id}`).set(as('manager')).expect(200)).body)
      .toEqual(beforeAttendance);

    // 앞으로 만드는 회차는 새 코호트(학생 1)만 스냅샷한다 — 취소가 미래에는 반영된다.
    const future = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, sessionDate: addDaysISO(PAST, 1), startTime: '11:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { studentIds?: number[] };
    expect(future.studentIds).toEqual([1]);
  });

  it('D4 — 동시 강사 출결 요청은 모두 차단되고 대표 기록만 영속화된다', async () => {
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, sessionDate: PAST, startTime: '14:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number };

    const [first, second] = await Promise.all([
      http.put(`/api/schedule/${created.id}/instructor-attendance`).set(bearer('park_inst')).send({ status: 'present' }),
      http.put(`/api/schedule/${created.id}/instructor-attendance`).set(bearer('park_inst')).send({ status: 'absent' }),
    ]);
    expect([first.status, second.status]).toEqual([403, 403]);

    // 거부된 요청은 저장 상태를 바꾸지 않는다.
    const readback = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(readback.instructorAttendance ?? null).toBeNull();

    await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(bearer('admin'))
      .send({ status: 'present' }).expect(200);
    expect((await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body.instructorAttendance).toBe('present');
  });

  // [TBO-79 F4] TBO-76 76E가 "미래→과거·과거→미래·자정 크로스를 검증한다"를 [x]로 닫았지만
  //  session-temporal-transition.e2e-spec은 과거→과거와 scope=all만 다뤘다(거짓 완료).
  //  여기서 미검증이던 두 방향과 자정 크로스를 못박는다.
  it('F4 — 미래 회차를 과거로 옮기면 출결이 초기화되고 강사 출결 배지가 생긴다', async () => {
    const FUTURE = addDaysISO(mondayISO(), 21);
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: FUTURE, startTime: '09:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number };
    const before = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(before).toMatchObject({ status: 'scheduled', attendanceRequired: false });
    expect(before.instructorAttendance ?? null).toBeNull();

    // 미래 → 과거. 시수·정산 델타가 0이므로 ack 없이 통과해야 한다(둘 다 scheduled).
    await http.patch(`/api/schedule/${created.id}`).set(as('manager'))
      .send({ sessionDate: addDaysISO(PAST, 3), startTime: '13:00', force: true }).expect(200);

    const after = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(after.status).toBe('scheduled');
    expect(after.instructorAttendance ?? null).toBeNull();
    expect(after.attendanceRequired).toBe(true); // 과거인데 미선택 → 배지
    expect(after.missingAttendance.instructor).toBe(true);
    expect(after.missingAttendance.studentIds).toEqual([1]);
    expect((await http.get(`/api/attendance?sessionId=${created.id}`).set(as('manager')).expect(200)).body).toEqual([]);

    // 같은 정책으로 재전이 — 출결을 다시 채우면 held.
    await http.put('/api/attendance').set(as('admin'))
      .send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);
    expect((await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body.status).toBe('scheduled');
    await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(bearer('admin'))
      .send({ status: 'present' }).expect(200);
    const held = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(held.status).toBe('held');
    expect(held.attendanceRequired).toBe(false);
  });

  it('F4 — 과거 held 회차를 미래로 옮기면 확인 후 scheduled로 되돌아간다', async () => {
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: addDaysISO(PAST, 4), startTime: '15:00', durationMinutes: 60, force: true })
      .expect(201)).body.row as { id: number };
    await http.put('/api/attendance').set(as('admin'))
      .send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);
    await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(as('admin'))
      .send({ status: 'present' }).expect(200);
    expect((await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body.status).toBe('held');

    const FUTURE = addDaysISO(mondayISO(), 28);
    const blocked = await http.patch(`/api/schedule/${created.id}`).set(as('manager'))
      .send({ sessionDate: FUTURE, force: true }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    // 거부된 요청은 무변경.
    expect((await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body.status).toBe('held');

    await http.patch(`/api/schedule/${created.id}`).set(as('manager')).send({
      sessionDate: FUTURE,
      force: true,
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(200);
    const after = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(after).toMatchObject({ status: 'scheduled', attendanceRequired: false });
    expect(after.instructorAttendance ?? null).toBeNull();
    expect((await http.get(`/api/attendance?sessionId=${created.id}`).set(as('manager')).expect(200)).body).toEqual([]);
  });

  it('F4 — 자정 크로스 회차도 같은 규칙으로 전이한다(endTime 익일)', async () => {
    const created = (await http.post('/api/schedule').set(as('manager'))
      .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: addDaysISO(PAST, 5), startTime: '23:00', durationMinutes: 120, force: true })
      .expect(201)).body.row as { id: number; durationMinutes: number };
    expect(created.durationMinutes).toBe(120);
    const row = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(row.attendanceRequired).toBe(true); // 자정을 넘겨 종료했지만 과거 = 출결 필요

    await http.put('/api/attendance').set(as('admin'))
      .send({ sessionId: created.id, studentId: 1, status: 'present' }).expect(200);
    await http.put(`/api/schedule/${created.id}/instructor-attendance`).set(bearer('admin'))
      .send({ status: 'present' }).expect(200);
    const held = (await http.get(`/api/schedule/${created.id}`).set(as('manager')).expect(200)).body;
    expect(held.status).toBe('held');
    expect(held.durationMinutes).toBe(120); // 자정 크로스 길이 보존(음수 파생 없음)
  });

  it('D5 — 출결·보고서 조회는 인증 없이 통과하지 않는다(fail-closed)', async () => {
    await http.get('/api/attendance').expect(401);
    await http.get('/api/reports').expect(401);
    // 강사 범위는 유지 — fail-closed로 바꾸면서 정상 경로가 막히지 않았는지 확인.
    await http.get('/api/attendance').set(bearer('park_inst')).expect(200);
    await http.get('/api/reports').set(bearer('park_inst')).expect(200);
  });
});
