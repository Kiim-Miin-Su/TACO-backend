import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { AuditService } from '../src/modules/audit/audit.service';
import { ATTENDANCE } from '../src/modules/attendance/attendance.entity';
import { SESSIONS } from '../src/modules/schedule/schedule.entity';
import {
  addDaysISO,
  createTestApp,
  E2E_APP_BOOT_TIMEOUT_MS,
  mondayISO,
} from './setup-app';

jest.setTimeout(30_000);
jest.retryTimes(0);

describe('[TBO-86D] 과거 완료 수업 원자 이관 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let db: InMemoryDatabase;
  const tokens: Record<string, string> = {};
  const auth = (webId: string) => ({ Authorization: `Bearer ${tokens[webId]}` });
  const historicalDate = addDaysISO(mondayISO(), -400);

  const body = (startTime: string, importReason: string) => ({
    courseId: 10,
    instructorId: 1,
    studentIds: [1],
    sessionDate: historicalDate,
    startTime,
    durationMinutes: 60,
    kind: 'class',
    mode: 'online',
    topic: `TBO-86D ${startTime}`,
    importReason,
  });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    db = app.get(InMemoryDatabase);
    for (const webId of ['admin', 'manager', 'park_inst']) {
      tokens[webId] = (await http.post('/api/auth/login')
        .send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  }, E2E_APP_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await app.close();
  });

  it('일반 create의 held 직접 주입은 계속 차단하고, 강사는 이관 command를 호출할 수 없다', async () => {
    await http.post('/api/schedule').set(auth('manager'))
      .send({ ...body('01:00', '일반 API 완료 주입 차단'), status: 'held' })
      .expect(400);
    await http.post('/api/schedule/historical-completed').set(auth('park_inst'))
      .send(body('02:00', '강사 권한 차단 검증'))
      .expect(403);
  });

  it('미종료·중복 학생·상담 이관은 쓰기 전에 거부한다', async () => {
    const futureDate = addDaysISO(mondayISO(), 30);
    await http.post('/api/schedule/historical-completed').set(auth('manager'))
      .send({ ...body('03:00', '미종료 수업 차단 검증'), sessionDate: futureDate })
      .expect(400);
    await http.post('/api/schedule/historical-completed').set(auth('manager'))
      .send({ ...body('03:30', '중복 학생 차단 검증'), studentIds: [1, 1] })
      .expect(400);
    await http.post('/api/schedule/historical-completed').set(auth('manager'))
      .send({ ...body('04:00', '상담 이관 차단 검증'), kind: 'counsel' })
      .expect(400);
  });

  it('매니저가 세션·출결·held·감사를 한 번에 만들고 시수 집계에 즉시 반영한다', async () => {
    const result = (await http.post('/api/schedule/historical-completed').set(auth('manager'))
      .send(body('05:00', '기존 7월 수업 기록 이관'))
      .expect(201)).body;

    expect(result.row).toMatchObject({
      status: 'held',
      instructorAttendance: 'present',
      instructorId: 1,
      studentIds: [1],
      sessionDate: historicalDate,
    });
    expect(result.attendance).toHaveLength(1);
    expect(result.attendance[0]).toMatchObject({
      sessionId: result.row.id,
      studentId: 1,
      status: 'present',
    });

    const readback = (await http.get(`/api/schedule/${result.row.id}`).set(auth('manager')).expect(200)).body;
    expect(readback).toMatchObject({ status: 'held', instructorAttendance: 'present', attendanceRequired: false });
    const attendance = (await http.get(`/api/attendance?sessionId=${result.row.id}`).set(auth('manager')).expect(200)).body;
    expect(attendance).toEqual(expect.arrayContaining([
      expect.objectContaining({ studentId: 1, status: 'present' }),
    ]));

    const summary = (await http.get('/api/schedule/instructor-attendance-summary').set(auth('manager')).query({
      from: historicalDate,
      to: historicalDate,
      instructorId: 1,
    }).expect(200)).body;
    expect(summary.rows[0]).toMatchObject({ held: 1, present: 1, teachingHours: 1 });

    const audits = (await http.get('/api/audit').set(auth('admin')).query({
      entity: 'class_sessions',
      entityId: result.row.id,
    }).expect(200)).body;
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'create', reason: '과거 완료 수업 이관: 기존 7월 수업 기록 이관' }),
      expect.objectContaining({ action: 'update', reason: '강사와 수강생 출결 완결 자동 진행 처리' }),
    ]));
  });

  it('출결 감사 저장이 늦게 실패하면 세션·출결·감사를 전부 롤백한다', async () => {
    const before = {
      sessions: db.findAll(SESSIONS).length,
      attendance: db.findAll(ATTENDANCE).length,
      audits: db.findAll('audit_log').length,
    };
    const audit = app.get(AuditService);
    const originalLog = audit.log.bind(audit);
    const spy = jest.spyOn(audit, 'log')
      .mockImplementationOnce(originalLog)
      .mockImplementationOnce(originalLog)
      .mockRejectedValueOnce(new Error('injected historical attendance audit failure'));

    await http.post('/api/schedule/historical-completed').set(auth('manager'))
      .send(body('06:00', '원자성 롤백 검증 이관'))
      .expect(500);
    spy.mockRestore();

    expect({
      sessions: db.findAll(SESSIONS).length,
      attendance: db.findAll(ATTENDANCE).length,
      audits: db.findAll('audit_log').length,
    }).toEqual(before);
    const rows = (await http.get('/api/schedule').set(auth('manager')).query({
      from: historicalDate,
      to: historicalDate,
    }).expect(200)).body;
    expect(rows.some((row: { startTime: string }) => row.startTime === '06:00')).toBe(false);
  });
});
