import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

describe('Staff attendance ledger (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' })
        .expect(201)).body.accessToken;
    }
  });

  afterAll(async () => app.close());

  it('대표가 직원·일자 기준으로 생성하고 같은 행을 수정하며 audit을 남긴다', async () => {
    const created = (await http.put('/api/staff-attendance').set(auth('admin')).send({
      staffId: 1,
      workDate: '2026-08-03',
      status: 'present',
      checkInAt: '2026-08-03T09:00:00+09:00',
      checkOutAt: '2026-08-03T18:00:00+09:00',
      memo: '정상 출근',
    }).expect(200)).body;
    const updated = (await http.put('/api/staff-attendance').set(auth('admin')).send({
      staffId: 1,
      workDate: '2026-08-03',
      status: 'paid_leave',
      memo: '유급 휴가',
    }).expect(200)).body;

    expect(updated).toMatchObject({ id: created.id, staffId: 1, workDate: '2026-08-03', status: 'paid_leave' });
    const rows = (await http.get('/api/staff-attendance?from=2026-08-01&to=2026-08-31&staffId=1')
      .set(auth('admin')).expect(200)).body;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.id);

    const audit = (await http.get(`/api/audit?entity=staff_attendance_records&entityId=${created.id}`)
      .set(auth('admin')).expect(200)).body;
    expect(audit.map((row: { action: string }) => row.action)).toEqual(expect.arrayContaining(['create', 'update']));
  });

  it('통합 ledger가 수업 출결과 직원 일별 출결을 source로 분리하고 이름 검색한다', async () => {
    await http.put('/api/staff-attendance').set(auth('admin')).send({
      staffId: 1,
      workDate: '2026-08-05',
      status: 'present',
      checkInAt: '2026-08-05T00:00:00.000Z',
      checkOutAt: '2026-08-05T09:00:00.000Z',
    }).expect(200);
    const ledger = (await http.get('/api/staff-attendance/instructor-ledger?from=2026-06-01&to=2026-08-31&q=박지훈')
      .set(auth('manager')).expect(200)).body;
    expect(ledger.entries.length).toBeGreaterThan(0);
    expect(ledger.entries.every((row: { instructorName: string }) => row.instructorName.includes('박지훈'))).toBe(true);
    expect(ledger.entries.some((row: { source: string }) => row.source === 'class_session')).toBe(true);
    expect(ledger.entries.some((row: { source: string; date: string }) => row.source === 'staff_day' && row.date === '2026-08-03')).toBe(true);
    expect(ledger.entries.find((row: { source: string; date: string }) => row.source === 'staff_day' && row.date === '2026-08-05'))
      .toMatchObject({ startTime: '09:00', endTime: '18:00' });
    expect(ledger.summary.staff.paid_leave).toBe(1);
    expect(ledger.summary.lessonEntries).toBeGreaterThan(0);
  });

  it('같은 직원·날짜 동시 upsert는 활성 행 하나만 유지한다', async () => {
    const input = { staffId: 1, workDate: '2026-08-04', memo: '동시 기록' };
    const responses = await Promise.all([
      http.put('/api/staff-attendance').set(auth('admin')).send({ ...input, status: 'present' }),
      http.put('/api/staff-attendance').set(auth('admin')).send({ ...input, status: 'remote_work' }),
    ]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    const rows = (await http.get('/api/staff-attendance?from=2026-08-04&to=2026-08-04&staffId=1')
      .set(auth('manager')).expect(200)).body;
    expect(rows).toHaveLength(1);
  });

  it('날짜·시간·직원 참조를 검증한다', async () => {
    await http.get('/api/staff-attendance?from=2026-08-31&to=2026-08-01').set(auth('manager')).expect(400);
    await http.get('/api/staff-attendance?from=2025-01-01&to=2026-08-03').set(auth('manager')).expect(400);
    await http.put('/api/staff-attendance').set(auth('admin')).send({
      staffId: 999999,
      workDate: '2026-08-03',
      status: 'present',
    }).expect(400);
    await http.put('/api/staff-attendance').set(auth('admin')).send({
      staffId: 1,
      workDate: '2026-08-05',
      status: 'present',
      checkInAt: '2026-08-05T09:00:00+09:00',
    }).expect(400);
    await http.put('/api/staff-attendance').set(auth('admin')).send({
      staffId: 1,
      workDate: '2026-08-05',
      status: 'present',
      checkInAt: '2026-08-04T23:00:00+09:00',
      checkOutAt: '2026-08-05T08:00:00+09:00',
    }).expect(400);
  });

  it('manager는 조회만 가능하고 강사는 관리 ledger와 C/U/D에 접근할 수 없다', async () => {
    await http.get('/api/staff-attendance?from=2026-08-01&to=2026-08-31').set(auth('manager')).expect(200);
    await http.put('/api/staff-attendance').set(auth('manager')).send({
      staffId: 1,
      workDate: '2026-08-06',
      status: 'present',
    }).expect(403);
    await http.get('/api/staff-attendance?from=2026-08-01&to=2026-08-31').set(auth('park_inst')).expect(403);
    await http.get('/api/staff-attendance/instructor-ledger?from=2026-08-01&to=2026-08-31').set(auth('park_inst')).expect(403);
    await http.put('/api/staff-attendance').set(auth('park_inst')).send({
      staffId: 1,
      workDate: '2026-08-06',
      status: 'present',
    }).expect(403);
  });

  it('삭제는 사유와 audit을 요구하고 목록에서 사라진다', async () => {
    const rows = (await http.get('/api/staff-attendance?from=2026-08-04&to=2026-08-04&staffId=1')
      .set(auth('manager')).expect(200)).body;
    const id = rows[0].id;
    await http.delete(`/api/staff-attendance/${id}`).set(auth('admin')).send({ reason: 'x' }).expect(400);
    await http.delete(`/api/staff-attendance/${id}`).set(auth('admin')).send({ reason: '중복 테스트 기록 정리' }).expect(200);
    const after = (await http.get('/api/staff-attendance?from=2026-08-04&to=2026-08-04&staffId=1')
      .set(auth('manager')).expect(200)).body;
    expect(after).toHaveLength(0);
    const audit = (await http.get(`/api/audit?entity=staff_attendance_records&entityId=${id}`)
      .set(auth('admin')).expect(200)).body;
    expect(audit.some((row: { action: string; reason: string }) => row.action === 'delete' && row.reason === '중복 테스트 기록 정리')).toBe(true);
  });
});
