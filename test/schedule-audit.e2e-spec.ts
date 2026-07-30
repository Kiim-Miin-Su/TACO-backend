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
    // [TBO-79 B1] 지각 전이는 정산 예상액을 바꾸므로 회계 확인이 선행된다(종전엔 정책 분기로 무ack 200).
    //  이 스위트의 관심사는 audit diff 노이즈이므로 ack만 통과시키고 단언은 그대로 둔다.
    const blocked = await http.patch(`/api/schedule/${sid}`).set(auth()).send({ instructorAttendance: 'late' }).expect(409);
    expect(blocked.body.code).toBe('ACCOUNTING_IMPACT_ACK_REQUIRED');
    await http.patch(`/api/schedule/${sid}`).set(auth()).send({
      instructorAttendance: 'late',
      acknowledgeAccountingImpact: true,
      expectedAccountingImpactHash: blocked.body.impactHash,
    }).expect(200);

    const log = (await http.get(`/api/audit?entity=class_sessions&entityId=${sid}`).set(auth()).expect(200)).body;
    const changes = log[0].changes ?? {};
    const keys = Object.keys(changes);
    expect(keys).toContain('instructorAttendance');
    expect(keys).not.toContain('kind');
    expect(keys).not.toContain('mode');
    expect(changes.instructorAttendance.after).toBe('late');
  });

  it('kind/mode를 실제로 바꾸면 그때는 diff에 기록', async () => {
    const held = (await http.get('/api/schedule?from=2026-06-01&to=2026-06-30&instructorId=1').set(auth()).expect(200)).body
      .filter((x: { status: string; payoutId?: number; mode?: string }) => x.status === 'held' && x.payoutId == null && x.mode !== 'online');
    const sid = held[0].id;
    await http.patch(`/api/schedule/${sid}`).set(auth()).send({
      mode: 'online',
      acknowledgeAccountingImpact: true,
    }).expect(200);
    const log = (await http.get(`/api/audit?entity=class_sessions&entityId=${sid}`).set(auth()).expect(200)).body;
    expect(Object.keys(log[0].changes ?? {})).toContain('mode');
  });
});
