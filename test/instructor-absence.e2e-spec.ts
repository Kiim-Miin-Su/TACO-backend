import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { addDaysISO, completeSessionByAttendance, createTestApp, mondayISO, setInstructorAttendanceAckingImpact } from './setup-app';

// [TBO-19] 강사 결석(instructorAttendance='absent')은 **status와 독립** — status는 held 유지(가역).
//  결석의 시수 처리 = payouts.measure가 absent 제외로 담당(status 미변경, payout-attendance.e2e 참조).
//  캘린더 '결강' 표시(회색·취소선)는 FE 렌더가 absent를 취소처럼 그림(status는 안 바꿈).
//  이 스펙은 "결석이 status를 canceled로 바꾸지 않는다"는 불변식을 지킴(회귀 방지).
describe('강사 결석 ↔ status 독립 (e2e) [TBO-19]', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let TOKEN = '';
  const TH = () => ({ Authorization: `Bearer ${TOKEN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    TOKEN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('instructorAttendance=absent는 status를 바꾸지 않는다(held 유지·가역)', async () => {
    const row = (await http.post('/api/schedule').set(TH())
      .send({
        courseId: 10,
        studentIds: [1],
        sessionDate: addDaysISO(mondayISO(), -7),
        startTime: '10:00',
        durationMinutes: 60,
        force: true,
      }).expect(201)).body.row;
    await completeSessionByAttendance(http, TH(), row.id, [1]);
    const absentRes = await setInstructorAttendanceAckingImpact(http, TH(), row.id, 'absent');
    expect(absentRes.status).toBe(200);
    const absent = absentRes.body.row;
    expect(absent.instructorAttendance).toBe('absent');
    expect(absent.status).toBe('held'); // 결강 표시는 FE 렌더 — status는 불변(payout은 measure가 별도 제외)
    // 정정: present로 되돌려도 status 그대로
    const restoredRes = await setInstructorAttendanceAckingImpact(http, TH(), row.id, 'present');
    expect(restoredRes.status).toBe(200);
    const restored = restoredRes.body.row;
    expect(restored.instructorAttendance).toBe('present');
    expect(restored.status).toBe('held');
  });
});
