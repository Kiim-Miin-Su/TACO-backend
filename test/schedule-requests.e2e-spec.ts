import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';

// TBO-16 #9 — 강사 수업 요청 → 매니저 승인/반려 + soft delete(v9) + audit_log(#7).
//  검증 축: ① 요청=세션과 동일 FK·코호트 검증 ② 승인=createSession 재사용(충돌 409 → tx 원자 롤백)
//  ③ 반려 사유 필수(Q2) ④ 수평 권한(강사=본인 요청만) ⑤ soft delete(철회·세션 삭제) ⑥ audit 기록·RBAC.
describe('Schedule Requests + Soft Delete + Audit (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  let INST = '';
  let INST2 = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });
  const asInst = () => ({ Authorization: `Bearer ${INST}` });
  const asInst2 = () => ({ Authorization: `Bearer ${INST2}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    INST = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
    INST2 = (await http.post('/api/auth/login').send({ webId: 'jung_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  const SLOT = { courseId: 10, sessionDate: '2099-01-04', startTime: '09:00', endTime: '10:00' };

  it('강사 요청 생성(pending) — 세션과 동일 검증 통과 + 참고용 conflicts 배열', async () => {
    const res = await http.post('/api/schedule-requests').set(asInst())
      .send({ ...SLOT, topic: '보충 요청', kind: 'class' }).expect(201);
    expect(res.body.row).toMatchObject({ status: 'pending', courseId: 10, instructorId: 1, requesterId: expect.any(Number) });
    expect(Array.isArray(res.body.conflicts)).toBe(true);
  });

  it('FK·코호트 무결성: 없는 코스 400 · 비수강생 코호트 400 (세션과 동일 규칙 재사용)', async () => {
    await http.post('/api/schedule-requests').set(asInst())
      .send({ ...SLOT, courseId: 9999 }).expect(400);
    await http.post('/api/schedule-requests').set(asInst())
      .send({ ...SLOT, studentIds: [9999] }).expect(400);
  });

  it('수평 권한: 강사 목록=본인 것만 · 승인은 관리자 전용(강사 403)', async () => {
    const mine = (await http.get('/api/schedule-requests').set(asInst()).expect(200)).body;
    expect(mine.every((r: { requesterId: number }) => r.requesterId === mine[0].requesterId)).toBe(true);
    const pending = mine.find((r: { status: string }) => r.status === 'pending');
    await http.post(`/api/schedule-requests/${pending.id}/approve`).set(asInst()).expect(403);
  });

  it('승인: 충돌 시 409 + 요청 pending 유지(tx 원자 롤백) → force 승인 시 세션 생성+역참조', async () => {
    // 같은 강사·시간에 세션 선점(double_book 보장)
    await http.post('/api/schedule').set(asAdmin()).send({ ...SLOT, force: true }).expect(201);
    const pending = (await http.get('/api/schedule-requests?status=pending').set(asAdmin()).expect(200)).body[0];

    // force 없이 승인 → 409, 요청은 여전히 pending(부분 반영 없음 — 원자성)
    await http.post(`/api/schedule-requests/${pending.id}/approve`).set(asAdmin()).expect(409);
    const still = (await http.get('/api/schedule-requests?status=pending').set(asAdmin()).expect(200)).body
      .find((r: { id: number }) => r.id === pending.id);
    expect(still).toBeDefined();

    // force 승인 → approved + createdSessionId + 실제 세션 존재
    const ok = (await http.post(`/api/schedule-requests/${pending.id}/approve?force=true`).set(asAdmin()).expect(201)).body;
    expect(ok.request.status).toBe('approved');
    expect(ok.request.createdSessionId).toBeGreaterThan(0);
    const rows = (await http.get(`/api/schedule?from=2099-01-04&to=2099-01-04`).set(asAdmin()).expect(200)).body;
    expect(rows.some((s: { id: number }) => s.id === ok.request.createdSessionId)).toBe(true);
    const audit = (await http.get(`/api/audit?entity=schedule_requests&entityId=${pending.id}`).set(asAdmin()).expect(200)).body;
    const approved = audit.find((a: { action: string }) => a.action === 'approve');
    expect(approved.changes.status).toMatchObject({ before: 'pending', after: 'approved' });
    expect(approved.changes.createdSessionId.after).toBe(ok.request.createdSessionId);
    // 이미 처리된 요청 재승인 400
    await http.post(`/api/schedule-requests/${pending.id}/approve?force=true`).set(asAdmin()).expect(400);
  });

  it('반려: 사유 필수(빈 body 400 — Q2) → 사유 포함 시 rejected+reason 저장', async () => {
    const req1 = (await http.post('/api/schedule-requests').set(asInst())
      .send({ ...SLOT, sessionDate: '2099-01-05' }).expect(201)).body.row;
    await http.post(`/api/schedule-requests/${req1.id}/reject`).set(asAdmin()).send({}).expect(400);
    const rej = (await http.post(`/api/schedule-requests/${req1.id}/reject`).set(asAdmin())
      .send({ reason: '해당 요일 강의실 부족' }).expect(201)).body;
    expect(rej).toMatchObject({ status: 'rejected', reason: '해당 요일 강의실 부족' });
  });

  it('QA 흐름: 강사 요청 2건 → 관리자 승인/반려 → 승인 세션 렌더 조회 + audit diff', async () => {
    const base = { courseId: 10, sessionDate: '2099-06-01', kind: 'class' as const };
    const toApprove = (await http.post('/api/schedule-requests').set(asInst())
      .send({ ...base, startTime: '08:00', endTime: '09:00', topic: 'QA 승인 요청' })
      .expect(201)).body.row;
    const toReject = (await http.post('/api/schedule-requests').set(asInst())
      .send({ ...base, startTime: '09:30', endTime: '10:30', topic: 'QA 반려 요청' })
      .expect(201)).body.row;

    const pending = (await http.get('/api/schedule-requests?status=pending').set(asAdmin()).expect(200)).body;
    expect(pending.some((r: { id: number }) => r.id === toApprove.id)).toBe(true);
    expect(pending.some((r: { id: number }) => r.id === toReject.id)).toBe(true);

    const approved = (await http.post(`/api/schedule-requests/${toApprove.id}/approve?force=true`).set(asAdmin()).expect(201)).body.request;
    expect(approved).toMatchObject({ status: 'approved', createdSessionId: expect.any(Number) });
    const rejected = (await http.post(`/api/schedule-requests/${toReject.id}/reject`).set(asAdmin())
      .send({ reason: 'QA 반려 사유' }).expect(201)).body;
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'QA 반려 사유' });

    const rows = (await http.get('/api/schedule?from=2099-06-01&to=2099-06-01').set(asAdmin()).expect(200)).body;
    expect(rows.some((s: { id: number; topic?: string }) => s.id === approved.createdSessionId && s.topic === 'QA 승인 요청')).toBe(true);
    const approveAudit = (await http.get(`/api/audit?entity=schedule_requests&entityId=${toApprove.id}`).set(asAdmin()).expect(200)).body
      .find((a: { action: string }) => a.action === 'approve');
    expect(approveAudit.changes.status).toMatchObject({ before: 'pending', after: 'approved' });
    expect(approveAudit.changes.createdSessionId.after).toBe(approved.createdSessionId);
  });

  it('[C3] 수업 변경 요청: 강사 drag/resize 결과를 pending으로 저장 → 관리자 승인 시 기존 세션 업데이트 + audit', async () => {
    const target = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-07-01', startTime: '16:00', endTime: '17:00', force: true, topic: '변경 대상 수업' })
      .expect(201)).body.row;

    await http.post('/api/schedule-requests').set(asInst2())
      .send({
        requestKind: 'session_update',
        targetSessionId: target.id,
        sessionDate: '2099-07-01',
        startTime: '17:30',
        endTime: '18:30',
        topic: '권한 없는 변경',
        requestReason: '권한 테스트',
        scope: 'this',
      })
      .expect(403);

    const made = (await http.post('/api/schedule-requests').set(asInst())
      .send({
        requestKind: 'session_update',
        targetSessionId: target.id,
        sessionDate: '2099-07-01',
        startTime: '17:30',
        endTime: '18:30',
        topic: '드래그 변경 요청',
        requestReason: '학부모 요청으로 30분 늦춥니다.',
        scope: 'this',
      })
      .expect(201)).body.row;
    expect(made).toMatchObject({
      status: 'pending',
      requestKind: 'session_update',
      targetSessionId: target.id,
      impactSessionIds: [target.id],
      startTime: '17:30',
      endTime: '18:30',
      requestReason: '학부모 요청으로 30분 늦춥니다.',
      scope: 'this',
    });
    expect(made.changeSummary).toContain('16:00-17:00 -> 17:30-18:30');

    const ok = (await http.post(`/api/schedule-requests/${made.id}/approve`).set(asAdmin()).expect(201)).body;
    expect(ok.request).toMatchObject({ status: 'approved', targetSessionId: target.id });
    const pendingAfter = (await http.get('/api/schedule-requests?status=pending').set(asAdmin()).expect(200)).body;
    expect(pendingAfter.some((r: { id: number }) => r.id === made.id)).toBe(false);

    const rows = (await http.get('/api/schedule?from=2099-07-01&to=2099-07-01').set(asAdmin()).expect(200)).body;
    const updated = rows.find((s: { id: number }) => s.id === target.id);
    expect(updated).toMatchObject({ startTime: '17:30', endTime: '18:30', topic: '드래그 변경 요청' });

    const sessionAudit = (await http.get(`/api/audit?entity=class_sessions&entityId=${target.id}`).set(asAdmin()).expect(200)).body;
    const sessionUpdate = sessionAudit.find((a: { action: string; changes?: Record<string, { before?: unknown; after?: unknown }> }) =>
      a.action === 'update' && a.changes?.startTime?.after === '17:30');
    expect(sessionUpdate).toBeDefined();
    expect(sessionUpdate!.changes?.endTime).toMatchObject({ before: '17:00', after: '18:30' });
    const requestAudit = (await http.get(`/api/audit?entity=schedule_requests&entityId=${made.id}`).set(asAdmin()).expect(200)).body;
    expect(requestAudit.find((a: { action: string }) => a.action === 'approve')?.changes.status).toMatchObject({ before: 'pending', after: 'approved' });
  });

  it('[C3b] 반복 수업 변경 요청: 사유와 적용 범위를 저장하고 승인 시 이후 세션까지 업데이트한다', async () => {
    const seriesId = 990901;
    const first = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, seriesId, sessionDate: '2099-08-03', startTime: '08:00', endTime: '09:00', force: true, topic: '반복 변경 1' })
      .expect(201)).body.row;
    const second = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, seriesId, sessionDate: '2099-08-10', startTime: '08:00', endTime: '09:00', force: true, topic: '반복 변경 2' })
      .expect(201)).body.row;

    const made = (await http.post('/api/schedule-requests').set(asInst())
      .send({
        requestKind: 'session_update',
        targetSessionId: first.id,
        sessionDate: '2099-08-03',
        startTime: '08:30',
        endTime: '09:30',
        topic: '반복 변경 1',
        requestReason: '반복 수업 시작 시간을 30분 늦춥니다.',
        scope: 'this_and_following',
      })
      .expect(201)).body.row;
    expect(made).toMatchObject({
      status: 'pending',
      requestKind: 'session_update',
      requestReason: '반복 수업 시작 시간을 30분 늦춥니다.',
      scope: 'this_and_following',
    });

    const ok = (await http.post(`/api/schedule-requests/${made.id}/approve?force=true`).set(asAdmin()).expect(201)).body;
    expect(ok.request).toMatchObject({ status: 'approved', scope: 'this_and_following' });

    const rows = (await http.get('/api/schedule?from=2099-08-03&to=2099-08-10').set(asAdmin()).expect(200)).body;
    expect(rows.find((s: { id: number }) => s.id === first.id)).toMatchObject({ startTime: '08:30', endTime: '09:30' });
    expect(rows.find((s: { id: number }) => s.id === second.id)).toMatchObject({ startTime: '08:30', endTime: '09:30' });
    const approved = (await http.get('/api/schedule-requests?status=approved').set(asAdmin()).expect(200)).body;
    expect(approved.some((r: { id: number; requestReason?: string }) => r.id === made.id && r.requestReason)).toBe(true);
  });

  it('[C4] 수업 삭제 요청: 강사 삭제 액션 → pending → 관리자 승인 시 세션 soft delete + audit', async () => {
    const target = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-07-02', startTime: '14:00', endTime: '15:00', force: true, topic: '삭제 요청 대상' })
      .expect(201)).body.row;

    await http.post('/api/schedule-requests').set(asInst2())
      .send({ requestKind: 'session_delete', targetSessionId: target.id })
      .expect(403);

    const made = (await http.post('/api/schedule-requests').set(asInst())
      .send({ requestKind: 'session_delete', targetSessionId: target.id })
      .expect(201)).body.row;
    expect(made).toMatchObject({
      status: 'pending',
      requestKind: 'session_delete',
      targetSessionId: target.id,
      impactSessionIds: [target.id],
      sessionDate: '2099-07-02',
      startTime: '14:00',
    });

    await http.patch(`/api/schedule-requests/${made.id}`).set(asAdmin()).send({ topic: '수정 불가' }).expect(400);

    const ok = (await http.post(`/api/schedule-requests/${made.id}/approve`).set(asAdmin()).expect(201)).body;
    expect(ok.request).toMatchObject({ status: 'approved', targetSessionId: target.id });

    const rows = (await http.get('/api/schedule?from=2099-07-02&to=2099-07-02').set(asAdmin()).expect(200)).body;
    expect(rows.some((s: { id: number }) => s.id === target.id)).toBe(false);

    const sessionAudit = (await http.get(`/api/audit?entity=class_sessions&entityId=${target.id}`).set(asAdmin()).expect(200)).body;
    expect(sessionAudit.find((a: { action: string }) => a.action === 'delete')?.changes.__row.before.id).toBe(target.id);
    const requestAudit = (await http.get(`/api/audit?entity=schedule_requests&entityId=${made.id}`).set(asAdmin()).expect(200)).body;
    expect(requestAudit.find((a: { action: string }) => a.action === 'approve')?.changes.status).toMatchObject({ before: 'pending', after: 'approved' });
  });

  it('철회(soft delete): 본인 pending만 — 목록에서 사라지되 audit에 delete 스냅샷 잔존', async () => {
    const req2 = (await http.post('/api/schedule-requests').set(asInst())
      .send({ ...SLOT, sessionDate: '2099-01-06' }).expect(201)).body.row;
    // 타인(관리자 계정도 requester 불일치) 철회 403
    await http.delete(`/api/schedule-requests/${req2.id}`).set(asAdmin()).expect(403);
    await http.delete(`/api/schedule-requests/${req2.id}`).set(asInst()).expect(200);
    const listed = (await http.get('/api/schedule-requests').set(asAdmin()).expect(200)).body;
    expect(listed.some((r: { id: number }) => r.id === req2.id)).toBe(false); // 기본 조회 제외(soft)
    const audit = (await http.get(`/api/audit?entity=schedule_requests&entityId=${req2.id}`).set(asAdmin()).expect(200)).body;
    expect(audit.some((a: { action: string }) => a.action === 'delete')).toBe(true); // 삭제도 DB에 저장
  });

  it('세션 soft delete: DELETE /schedule → 조회 제외 + audit delete(before 전체 스냅샷)', async () => {
    const created = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-02-01', startTime: '10:00', endTime: '11:00', force: true, kind: 'level_test', price: 30000 })
      .expect(201)).body.row;
    expect(created.kind).toBe('level_test'); // [v0.1.14] kind 저장 확인
    expect(created.price).toBe(30000);
    await http.delete(`/api/schedule/${created.id}`).set(asAdmin()).expect(200);
    const rows = (await http.get('/api/schedule?from=2099-02-01&to=2099-02-01').set(asAdmin()).expect(200)).body;
    expect(rows.some((s: { id: number }) => s.id === created.id)).toBe(false);
    const audit = (await http.get(`/api/audit?entity=class_sessions&entityId=${created.id}`).set(asAdmin()).expect(200)).body;
    const del = audit.find((a: { action: string }) => a.action === 'delete');
    expect(del).toBeDefined();
    expect(del.changes.__row.before.id).toBe(created.id); // 복원 근거 스냅샷
  });

  it('audit RBAC: 조회는 관리자 전용(강사 403) · 세션 update가 diff로 기록된다', async () => {
    await http.get('/api/audit').set(asInst()).expect(403);
    const created = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 11, sessionDate: '2099-02-02', startTime: '09:00', endTime: '10:00', force: true }).expect(201)).body.row;
    await http.patch(`/api/schedule/${created.id}`).set(asAdmin()).send({ startTime: '11:00', force: true }).expect(200);
    const audit = (await http.get(`/api/audit?entity=class_sessions&entityId=${created.id}`).set(asAdmin()).expect(200)).body;
    const upd = audit.find((a: { action: string }) => a.action === 'update');
    expect(upd?.changes?.startTime?.after).toBe('11:00'); // 누가·언제·무엇을·어떻게(diff)
  });

  it('가용시간 훼손: 강사 직접 변경은 승인 필요 409 → 요청 생성 → 관리자 승인 시 availability audit 기록', async () => {
    // 강사1 월요일 available(14:00-20:00) 안에 미래 수업을 하나 만든 뒤, available을 16:00까지 줄이면 수업이 밖으로 밀린다.
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 10, sessionDate: '2099-03-02', startTime: '16:30', endTime: '17:30', force: true })
      .expect(201);
    const blocks = (await http.get('/api/availability?ownerType=instructor&ownerId=1').set(asAdmin()).expect(200)).body;
    const monAvailable = blocks.find((b: { kind: string; weekday: number; startTime: string }) =>
      b.kind === 'available' && b.weekday === 1 && b.startTime === '14:00');
    expect(monAvailable?.id).toBeGreaterThan(0);

    const shrink = {
      id: monAvailable.id, ownerType: 'instructor', ownerId: 1, kind: 'available',
      weekday: 1, startTime: '14:00', endTime: '16:00',
    };
    const blocked = await http.put('/api/availability').set(asInst()).send(shrink).expect(409);
    expect(blocked.body).toMatchObject({ approvalRequired: true });
    expect(blocked.body.impactedSessions?.some((s: { sessionDate: string }) => s.sessionDate === '2099-03-02')).toBe(true);

    const req = (await http.post('/api/schedule-requests').set(asInst())
      .send({
        requestKind: 'availability_upsert',
        targetAvailabilityId: monAvailable.id,
        availabilityOwnerType: 'instructor',
        availabilityOwnerId: 1,
        availabilityKind: 'available',
        availabilityWeekday: 1,
        availabilityStartTime: '14:00',
        availabilityEndTime: '16:00',
      })
      .expect(201)).body.row;
    expect(req).toMatchObject({ status: 'pending', requestKind: 'availability_upsert', targetAvailabilityId: monAvailable.id });
    expect(req.impactSessionIds).toEqual(expect.arrayContaining([expect.any(Number)]));

    const approved = (await http.post(`/api/schedule-requests/${req.id}/approve`).set(asAdmin()).expect(201)).body.request;
    expect(approved.status).toBe('approved');
    const changed = (await http.get('/api/availability?ownerType=instructor&ownerId=1').set(asAdmin()).expect(200)).body
      .find((b: { id: number }) => b.id === monAvailable.id);
    expect(changed.endTime).toBe('16:00');
    const audit = (await http.get(`/api/audit?entity=availability_blocks&entityId=${monAvailable.id}`).set(asAdmin()).expect(200)).body;
    expect(audit.some((a: { action: string; changes?: { endTime?: { after?: string } } }) => a.action === 'update' && a.changes?.endTime?.after === '16:00')).toBe(true);
    const reqAudit = (await http.get(`/api/audit?entity=schedule_requests&entityId=${req.id}`).set(asAdmin()).expect(200)).body;
    const reqApproved = reqAudit.find((a: { action: string }) => a.action === 'approve');
    expect(reqApproved.changes.status).toMatchObject({ before: 'pending', after: 'approved' });
  });

  it('availability 요청 검증: 기존 블록과 겹치는 변경은 pending 요청으로 접수하지 않는다', async () => {
    await http.post('/api/schedule-requests').set(asInst())
      .send({
        requestKind: 'availability_upsert',
        availabilityOwnerType: 'instructor',
        availabilityOwnerId: 1,
        availabilityKind: 'available',
        availabilityWeekday: 3,
        availabilityStartTime: '15:00',
        availabilityEndTime: '17:30',
        availabilityEffectiveFrom: '2099-03-03',
        availabilityEffectiveTo: '2099-03-03',
      })
      .expect(409);
  });

  it('online_only: 온라인만 가능 블록은 대면 수업을 막고 온라인 수업은 허용한다', async () => {
    await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 11, sessionDate: '2099-03-02', startTime: '20:30', endTime: '21:30' })
      .expect(409);
    const online = (await http.post('/api/schedule').set(asAdmin())
      .send({ courseId: 11, sessionDate: '2099-03-02', startTime: '20:30', endTime: '21:30', mode: 'online' })
      .expect(201)).body.row;
    expect(online.mode).toBe('online');
  });

  it('[C2D] 요청 mode 보존: mode=online 요청 승인 → 세션 mode=online · 미지정 요청 → in_person 기본', async () => {
    // ① mode=online 요청 → pending row에 mode 보존 → 승인 세션 mode=online
    const made = (await http.post('/api/schedule-requests').set(asInst())
      .send({ courseId: 10, sessionDate: '2099-04-06', startTime: '09:00', endTime: '10:00', mode: 'online', topic: 'C2D 보존' })
      .expect(201)).body.row;
    expect(made.mode).toBe('online');
    const ok = (await http.post(`/api/schedule-requests/${made.id}/approve`).set(asAdmin()).expect(201)).body;
    const created = (await http.get('/api/schedule').set(asAdmin()).expect(200)).body
      .find((r: { id: number }) => r.id === ok.request.createdSessionId);
    expect(created.mode).toBe('online');

    // ② mode 미지정 → 승인 세션은 SESSION_DEFAULTS(in_person)
    const plain = (await http.post('/api/schedule-requests').set(asInst())
      .send({ courseId: 10, sessionDate: '2099-04-06', startTime: '10:30', endTime: '11:30' })
      .expect(201)).body.row;
    const ok2 = (await http.post(`/api/schedule-requests/${plain.id}/approve`).set(asAdmin()).expect(201)).body;
    const created2 = (await http.get('/api/schedule').set(asAdmin()).expect(200)).body
      .find((r: { id: number }) => r.id === ok2.request.createdSessionId);
    expect(created2.mode).toBe('in_person');

    // ③ 잘못된 mode 값은 400 (화이트리스트)
    await http.post('/api/schedule-requests').set(asInst())
      .send({ courseId: 10, sessionDate: '2099-04-06', startTime: '12:00', endTime: '13:00', mode: 'hybrid' })
      .expect(400);
  });

  it('[C2C-b] 요청 수정(PATCH): 관리자 값 반영+audit diff → 승인 시 수정값 세션 · 강사 403 · 종류전환 400 · 비pending 400', async () => {
    const made = (await http.post('/api/schedule-requests').set(asInst())
      .send({ courseId: 10, sessionDate: '2099-05-04', startTime: '09:00', endTime: '10:00', mode: 'in_person' })
      .expect(201)).body.row;
    // 강사 수정 403(관리자 전용)
    await http.patch(`/api/schedule-requests/${made.id}`).set(asInst()).send({ topic: 'x' }).expect(403);
    // 불변 필드(requestKind) 전송 → forbidNonWhitelisted 400
    await http.patch(`/api/schedule-requests/${made.id}`).set(asAdmin()).send({ requestKind: 'availability_delete' }).expect(400);
    // 잘못된 FK 400(생성과 동일 검증 재사용)
    await http.patch(`/api/schedule-requests/${made.id}`).set(asAdmin()).send({ courseId: 9999 }).expect(400);
    // 관리자 수정 → 값 반영(pending 유지)
    const upd = (await http.patch(`/api/schedule-requests/${made.id}`).set(asAdmin())
      .send({ startTime: '11:00', endTime: '12:00', mode: 'online', topic: '수정됨' }).expect(200)).body;
    expect(upd).toMatchObject({ startTime: '11:00', endTime: '12:00', mode: 'online', topic: '수정됨', status: 'pending' });
    // audit update diff(누가·무엇을 — before/after)
    const audit = (await http.get(`/api/audit?entity=schedule_requests&entityId=${made.id}`).set(asAdmin()).expect(200)).body;
    const u = audit.find((a: { action: string }) => a.action === 'update');
    expect(u.changes.startTime).toMatchObject({ before: '09:00', after: '11:00' });
    expect(u.changes.mode).toMatchObject({ after: 'online' });
    // 승인 → 수정값으로 세션 생성
    const ok = (await http.post(`/api/schedule-requests/${made.id}/approve`).set(asAdmin()).expect(201)).body;
    const created = (await http.get('/api/schedule').set(asAdmin()).expect(200)).body
      .find((r: { id: number }) => r.id === ok.request.createdSessionId);
    expect(created).toMatchObject({ startTime: '11:00', mode: 'online' });
    // 비pending(approved) 수정 400
    await http.patch(`/api/schedule-requests/${made.id}`).set(asAdmin()).send({ topic: 'y' }).expect(400);
  });

  it('[C2C-b] availability 요청 수정: upsert=시간 변경 시 impact/요약 재계산 · delete=수정 불가 400', async () => {
    // 전용 블록 생성(토요일 09-10, 세션 없음 — 결정적)
    const blk = (await http.put('/api/availability').set(asAdmin())
      .send({ ownerType: 'instructor', ownerId: 1, kind: 'available', weekday: 6, startTime: '09:00', endTime: '10:00' })
      .expect(200)).body;
    // upsert 요청(시간 축소) 생성 → 관리자 수정(다른 시간) → 요약 재계산 반영
    const up = (await http.post('/api/schedule-requests').set(asInst())
      .send({ requestKind: 'availability_upsert', targetAvailabilityId: blk.id, availabilityOwnerType: 'instructor', availabilityOwnerId: 1, availabilityKind: 'available', availabilityWeekday: 6, availabilityStartTime: '09:00', availabilityEndTime: '09:30' })
      .expect(201)).body.row;
    const upd = (await http.patch(`/api/schedule-requests/${up.id}`).set(asAdmin())
      .send({ availabilityEndTime: '09:45' }).expect(200)).body;
    expect(upd.availabilityEndTime).toBe('09:45');
    expect(upd.changeSummary).toContain('09:00–09:45');
    // owner 전환 시도(불변 필드) → 400
    await http.patch(`/api/schedule-requests/${up.id}`).set(asAdmin()).send({ availabilityOwnerId: 2 }).expect(400);
    await http.delete(`/api/schedule-requests/${up.id}`).set(asInst()).expect(200); // 정리
    // delete 요청은 수정 불가
    const del = (await http.post('/api/schedule-requests').set(asInst())
      .send({ requestKind: 'availability_delete', targetAvailabilityId: blk.id }).expect(201)).body.row;
    expect(del).toMatchObject({
      requestKind: 'availability_delete',
      targetAvailabilityId: blk.id,
      availabilityOwnerType: 'instructor',
      availabilityOwnerId: 1,
      availabilityKind: 'available',
      availabilityWeekday: 6,
      availabilityStartTime: '09:00',
      availabilityEndTime: '10:00',
    });
    await http.patch(`/api/schedule-requests/${del.id}`).set(asAdmin()).send({ availabilityStartTime: '10:00' }).expect(400);
  });
});
