import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// [R-6 노이즈 정리] 시드/구 세션(kind·mode 미저장) 부분 PATCH 시 audit diff에 미변경 kind/mode가
//  섞이지 않음을 검증. mergeFields가 기본값을 채우지 않고 보존하도록 바뀐 규약을 잠근다.
describe('세션 audit diff 노이즈 정리 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const auth = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => app.close());

  it('시드 세션 강사출결만 변경 → audit changes에 instructorAttendance만(미변경 kind/mode 없음)', async () => {
    // payouts 시드의 held 세션(강사1, kind 미저장)
    const held = (await http.get('/api/schedule?from=2026-06-01&to=2026-06-30&instructorId=1').set(auth()).expect(200)).body
      .filter((x: { status: string }) => x.status === 'held');
    const sid = held[0].id;
    await http.patch(`/api/schedule/${sid}`).set(auth()).send({ instructorAttendance: 'late' }).expect(200);

    const log = (await http.get(`/api/audit?entity=class_sessions&entityId=${sid}`).set(auth()).expect(200)).body;
    const changes = log[0].changes ?? {};
    const keys = Object.keys(changes);
    expect(keys).toContain('instructorAttendance');
    expect(keys).not.toContain('kind');
    expect(keys).not.toContain('mode');
    expect(changes.instructorAttendance.after).toBe('late');
  });

  it('kind/mode를 실제로 바꾸면 그때는 diff에 기록', async () => {
    const held = (await http.get('/api/schedule?from=2026-06-01&to=2026-06-30&instructorId=2').set(auth()).expect(200)).body
      .filter((x: { status: string }) => x.status === 'held');
    const sid = held[0].id;
    await http.patch(`/api/schedule/${sid}`).set(auth()).send({ mode: 'online' }).expect(200);
    const log = (await http.get(`/api/audit?entity=class_sessions&entityId=${sid}`).set(auth()).expect(200)).body;
    expect(Object.keys(log[0].changes ?? {})).toContain('mode');
  });
});
