import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { AuditService } from '../src/modules/audit/audit.service';

// 상담(counsel) 모듈 e2e — 시드 목록 + rounds↔forms FK 무결성.
describe('Counsel API (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  let INSTRUCTOR = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    INSTRUCTOR = (await http.post('/api/auth/login').send({ webId: 'park_inst', password: 'demo1234' }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  it('상담 폼·회차·예약일은 관리 역할 전용이며 강사는 URL 직접 접근도 403', async () => {
    const asInstructor = { Authorization: `Bearer ${INSTRUCTOR}` };
    await http.get('/api/counsel').set(asInstructor).expect(403);
    await http.get('/api/counsel/rounds').set(asInstructor).expect(403);
    await http.get('/api/counsel/1').set(asInstructor).expect(403);
    await http.post('/api/counsel').set(asInstructor).send({ applicantName: '권한차단', source: 'manual' }).expect(403);
    await http.patch('/api/counsel/1').set(asInstructor).send({ applicantName: '권한차단' }).expect(403);
    await http.delete('/api/counsel/1').set(asInstructor).expect(403);
    await http.post('/api/counsel/1/rounds').set(asInstructor).send({ summary: '권한차단' }).expect(403);
  });

  it('GET /counsel — 상담 접수 3건(시드)', async () => {
    const forms = (await http.get('/api/counsel').set(asAdmin()).expect(200)).body;
    expect(forms.length).toBe(3);
    expect(forms.map((form: { id: number }) => form.id)).toEqual([3, 2, 1]); // 최근 접수순
    const statuses = forms.map((f: { status: string }) => f.status).sort();
    expect(statuses).toEqual(['pending', 'registered', 'requested']);
  });

  it('상담 탭 배지 기준: status≠dropped ∧ nextContactAt 없음 → 2건(등록·신규)', async () => {
    const forms = (await http.get('/api/counsel').set(asAdmin()).expect(200)).body;
    const badge = forms.filter((f: { status: string; nextContactAt?: string }) => f.status !== 'dropped' && !f.nextContactAt);
    expect(badge.length).toBe(2);
  });

  it('GET /counsel/rounds — 회차 4건, 모두 유효한 counselFormId(FK 무결성)', async () => {
    const forms = (await http.get('/api/counsel').set(asAdmin()).expect(200)).body;
    const formIds = new Set(forms.map((f: { id: number }) => f.id));
    const rounds = (await http.get('/api/counsel/rounds').set(asAdmin()).expect(200)).body;
    expect(rounds.length).toBe(4);
    expect(rounds.every((r: { counselFormId: number }) => formIds.has(r.counselFormId))).toBe(true);
    expect(rounds.every((r: { formSnapshot?: { applicantName?: string } }) => Boolean(r.formSnapshot?.applicantName))).toBe(true);
  });

  it('GET /counsel/rounds?counselFormId=1 — 폼1의 회차 2건', async () => {
    const rounds = (await http.get('/api/counsel/rounds?counselFormId=1').set(asAdmin()).expect(200)).body;
    expect(rounds.length).toBe(2);
    expect(rounds.every((r: { counselFormId: number }) => r.counselFormId === 1)).toBe(true);
  });

  // ── CRUD (B단계) ──
  it('POST /counsel — 접수 생성(status=requested), 권한: 비로그인 401', async () => {
    await http.post('/api/counsel').send({ applicantName: 'x', source: 'manual' }).expect(401);
    const token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    const f = (await http.post('/api/counsel').set({ Authorization: `Bearer ${token}` })
      .send({ applicantName: '문의진', applicantPhone: '010-1', source: 'manual', interestSubjectId: 1 }).expect(201)).body;
    expect(f).toMatchObject({ applicantName: '문의진', status: 'requested' });
    expect(f.id).toBeGreaterThan(3);
  });

  it('POST/PATCH /counsel — 폼 전체 입력과 다음 상담일을 저장·해제하고 audit에 남긴다', async () => {
    const created = (await http.post('/api/counsel').set(asAdmin()).send({
      applicantName: '전체입력', applicantPhone: '010-1234-5678', source: 'manual', submitterType: 'parent', assignedStaffId: 3,
      interestSubjectId: 1, interestCourseId: 10, academyExpectation: '정기 피드백',
      desiredStartTime: 'within_1_month', learningAtmosphere: 'needs_management',
      studentIntention: 'student_wants', weakness: '어휘', nextContactAt: '2099-07-21',
    }).expect(201)).body;
    expect(created).toMatchObject({
      applicantName: '전체입력', applicantPhone: '010-1234-5678', submitterType: 'parent', assignedStaffId: 3,
      interestSubjectId: 1, interestCourseId: 10, academyExpectation: '정기 피드백',
      desiredStartTime: 'within_1_month', learningAtmosphere: 'needs_management',
      studentIntention: 'student_wants', weakness: '어휘', nextContactAt: '2099-07-21',
    });

    const updated = (await http.patch(`/api/counsel/${created.id}`).set(asAdmin()).send({
      applicantName: '전체수정', source: 'google_form', submitterType: 'student', applicantPhone: null, interestSubjectId: null, interestCourseId: null,
      academyExpectation: null, desiredStartTime: 'undecided', learningAtmosphere: 'normal',
      studentIntention: 'unknown', weakness: null, nextContactAt: '2099-07-22',
    }).expect(200)).body;
    expect(updated).toMatchObject({
      applicantName: '전체수정', source: 'google_form', submitterType: 'student', applicantPhone: null, interestSubjectId: null, interestCourseId: null,
      academyExpectation: null, desiredStartTime: 'undecided', learningAtmosphere: 'normal',
      studentIntention: 'unknown', weakness: null, nextContactAt: '2099-07-22',
    });

    const cleared = (await http.patch(`/api/counsel/${created.id}`).set(asAdmin())
      .send({ nextContactAt: null }).expect(200)).body;
    expect(cleared.nextContactAt).toBeNull();
    const readback = (await http.get(`/api/counsel/${created.id}`).set(asAdmin()).expect(200)).body;
    expect(readback.nextContactAt).toBeNull();

    const audit = (await http.get(`/api/audit?entity=counsel_forms&entityId=${created.id}`).set(asAdmin()).expect(200)).body;
    const update = audit.find((row: { action: string; changes?: Record<string, unknown> }) =>
      row.action === 'update' && row.changes?.applicantName);
    expect(update).toBeDefined();
    expect(update.actorId).toBe(3);
    expect(update.changes.nextContactAt.after).toBe('2099-07-22');
    expect(update.changes.applicantPhone).toEqual({ before: '[masked]', after: '[masked]' });
  });

  it('POST /counsel — 없는 interestCourseId → 400(FK)', async () => {
    const token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.post('/api/counsel').set({ Authorization: `Bearer ${token}` })
      .send({ applicantName: 'x', source: 'manual', interestCourseId: 99999 }).expect(400);
  });

  it('POST/PATCH/round — 존재하지 않는 담당 직원 FK는 400', async () => {
    await http.post('/api/counsel').set(asAdmin())
      .send({ applicantName: 'x', source: 'manual', assignedStaffId: 99999 }).expect(400);
    await http.patch('/api/counsel/1').set(asAdmin()).send({ assignedStaffId: 99999 }).expect(400);
    await http.post('/api/counsel/1/rounds').set(asAdmin()).send({ counselorId: 99999, summary: 'x' }).expect(400);
  });

  it('PATCH /counsel/:id — 상태 전환(pending→registered)', async () => {
    const token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    const r = (await http.patch('/api/counsel/1').set({ Authorization: `Bearer ${token}` }).send({ status: 'registered' }).expect(200)).body;
    expect(r.status).toBe('registered');
  });

  it('POST /counsel/:id/rounds — 회차 자동 증가 + 폼 nextContactAt 동기화', async () => {
    const token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    const before = (await http.get('/api/counsel/rounds?counselFormId=2').set(asAdmin()).expect(200)).body;
    const maxNo = before.reduce((m: number, r: { roundNo: number }) => Math.max(m, r.roundNo), -1);
    const round = (await http.post('/api/counsel/2/rounds').set({ Authorization: `Bearer ${token}` })
      .send({
        summary: '추가 상담', result: 'positive',
        formSnapshot: {
          applicantName: '오민재', applicantPhone: '010-8888-3434', status: 'registered', source: 'naver_form',
          submitterType: 'student', weakness: '1차에서 확인된 약점', nextContactAt: '2026-09-01',
        },
      }).expect(201)).body;
    expect(round.roundNo).toBe(maxNo + 1);
    expect(round.counselFormId).toBe(2);
    expect(round.formSnapshot).toMatchObject({
      applicantName: '오민재', submitterType: 'student', weakness: '1차에서 확인된 약점', nextContactAt: '2026-09-01',
    });
    const form = (await http.get('/api/counsel').set(asAdmin()).expect(200)).body.find((f: { id: number }) => f.id === 2);
    expect(form.nextContactAt).toBe('2026-09-01'); // 폼 동기화
    const audit = (await http.get('/api/audit?entity=counsel_forms&entityId=2').set(asAdmin()).expect(200)).body;
    const sync = audit.find((row: { action: string; changes?: { nextContactAt?: { after?: string } } }) =>
      row.action === 'update' && row.changes?.nextContactAt?.after === '2026-09-01');
    expect(sync).toMatchObject({ actorId: 3 });
    const roundAudit = (await http.get(`/api/audit?entity=counsel_rounds&entityId=${round.id}`).set(asAdmin()).expect(200)).body[0];
    expect(roundAudit.changes.formSnapshot.after.applicantPhone).toBe('[masked]');

    await http.patch('/api/counsel/2').set(asAdmin()).send({ weakness: '최초 폼에서 나중에 수정' }).expect(200);
    const persisted = (await http.get('/api/counsel/rounds?counselFormId=2').set(asAdmin()).expect(200)).body
      .find((item: { id: number }) => item.id === round.id);
    expect(persisted.formSnapshot.weakness).toBe('1차에서 확인된 약점'); // 최초 폼 후속 수정과 독립
  });

  it('POST /counsel/:id/rounds — 예약일 audit 실패 시 회차와 부모 현재값을 함께 롤백한다', async () => {
    const beforeRounds = (await http.get('/api/counsel/rounds?counselFormId=3').set(asAdmin()).expect(200)).body;
    const audit = app.get(AuditService);
    const fail = jest.spyOn(audit, 'log').mockRejectedValueOnce(new Error('injected counsel sync audit failure'));
    await http.post('/api/counsel/3/rounds').set(asAdmin())
      .send({ summary: '롤백 대상', nextContactAt: '2026-09-02' }).expect(500);
    fail.mockRestore();

    const afterForm = (await http.get('/api/counsel/3').set(asAdmin()).expect(200)).body;
    const afterRounds = (await http.get('/api/counsel/rounds?counselFormId=3').set(asAdmin()).expect(200)).body;
    expect(afterForm.nextContactAt == null).toBe(true);
    expect(afterRounds).toHaveLength(beforeRounds.length);
  });

  it('POST /counsel/:id/rounds — 없는 폼 → 404', async () => {
    const token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    await http.post('/api/counsel/99999/rounds').set({ Authorization: `Bearer ${token}` }).send({ summary: 'x' }).expect(404);
  });

  it('DELETE /counsel/:id — 폼과 연결 회차를 함께 soft delete한다', async () => {
    const token = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    const created = (await http.post('/api/counsel').set({ Authorization: `Bearer ${token}` })
      .send({ applicantName: '삭제 검증', source: 'manual' }).expect(201)).body;
    await http.post(`/api/counsel/${created.id}/rounds`).set({ Authorization: `Bearer ${token}` })
      .send({ summary: '삭제될 회차' }).expect(201);

    await http.delete(`/api/counsel/${created.id}`).expect(401);
    await http.delete(`/api/counsel/${created.id}`).set({ Authorization: `Bearer ${token}` }).expect(200);
    await http.get(`/api/counsel/${created.id}`).set({ Authorization: `Bearer ${token}` }).expect(404);
    const rounds = (await http.get(`/api/counsel/rounds?counselFormId=${created.id}`).set(asAdmin()).expect(200)).body;
    expect(rounds).toEqual([]);
  });

  // ── [2026-07-07] 취약점·엣지 케이스 보강 ──
  describe('검증·엣지 (2026-07-07)', () => {
    let TOKEN = '';
    const TH = () => ({ Authorization: `Bearer ${TOKEN}` });
    beforeAll(async () => {
      TOKEN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    });

    it('POST /counsel — 자유 텍스트 상한 초과 → 400(applicantName 60·weakness 500)', async () => {
      await http.post('/api/counsel').set(TH())
        .send({ applicantName: 'x'.repeat(61), source: 'manual' }).expect(400);
      await http.post('/api/counsel').set(TH())
        .send({ applicantName: 'ok', source: 'manual', weakness: 'w'.repeat(501) }).expect(400);
      // 경계값(정확히 상한)은 통과
      await http.post('/api/counsel').set(TH())
        .send({ applicantName: 'n'.repeat(60), source: 'manual', weakness: 'w'.repeat(500) }).expect(201);
    });

    it('POST /counsel/:id/rounds — detail 상한(2000) 초과 → 400', async () => {
      await http.post('/api/counsel/1/rounds').set(TH())
        .send({ summary: 's', detail: 'd'.repeat(2001) }).expect(400);
    });

    it('POST /counsel — 생성 시 status는 항상 requested(정상 생성)', async () => {
      const f = (await http.post('/api/counsel').set(TH())
        .send({ applicantName: '신규접수', source: 'manual' }).expect(201)).body;
      expect(f.status).toBe('requested'); // 서비스가 강제
    });

    it('POST/PATCH /counsel — nextContactAt 형식 오류 → 400', async () => {
      await http.post('/api/counsel').set(TH())
        .send({ applicantName: '날짜오류', source: 'manual', nextContactAt: '21-07-2026' }).expect(400);
      await http.patch('/api/counsel/1').set(TH()).send({ nextContactAt: 'tomorrow' }).expect(400);
    });

    it('POST/PATCH /counsel — 작성 주체 enum 밖의 값 → 400', async () => {
      await http.post('/api/counsel').set(TH())
        .send({ applicantName: '주체오류', source: 'manual', submitterType: 'anonymous' }).expect(400);
      await http.patch('/api/counsel/1').set(TH()).send({ submitterType: 'anonymous' }).expect(400);
    });

    it('POST /counsel/:id/rounds — 스냅샷 내부 미허용 키·필수값 누락 → 400', async () => {
      await http.post('/api/counsel/1/rounds').set(TH()).send({
        formSnapshot: { applicantName: 'x', status: 'pending', source: 'manual', submitterType: 'staff', hackerField: 1 },
      }).expect(400);
      await http.post('/api/counsel/1/rounds').set(TH()).send({
        formSnapshot: { status: 'pending', source: 'manual', submitterType: 'staff' },
      }).expect(400);
    });

    it('POST /counsel — 미허용 필드(status·임의 키)는 forbidNonWhitelisted로 400(상태 주입 차단)', async () => {
      // CreateCounselDto에 status 필드가 없어 클라가 초기 상태를 주입할 수 없다(400).
      await http.post('/api/counsel').set(TH())
        .send({ applicantName: 'ok', source: 'manual', status: 'registered' }).expect(400);
      await http.post('/api/counsel').set(TH())
        .send({ applicantName: 'ok', source: 'manual', hackerField: 1 }).expect(400);
    });

    it('PATCH /counsel/:id — 없는 interestSubjectId → 400(FK)', async () => {
      await http.patch('/api/counsel/1').set(TH()).send({ interestSubjectId: 99999 }).expect(400);
    });

    it('PATCH /counsel/:id — 없는 폼 → 404', async () => {
      await http.patch('/api/counsel/99999').set(TH()).send({ status: 'pending' }).expect(404);
    });

    it('POST /counsel/:id/rounds — nextContactAt 미지정이면 폼 동기화 안 함(기존 값 유지)', async () => {
      // 폼3(신규): nextContactAt 없음 → 회차만 추가하고 nextContactAt 미전송 시 계속 미정
      const before = (await http.get('/api/counsel').set(asAdmin()).expect(200)).body.find((f: { id: number }) => f.id === 3);
      expect(before.nextContactAt == null).toBe(true);
      await http.post('/api/counsel/3/rounds').set(TH()).send({ summary: '동기화 미대상' }).expect(201);
      const after = (await http.get('/api/counsel').set(asAdmin()).expect(200)).body.find((f: { id: number }) => f.id === 3);
      expect(after.nextContactAt == null).toBe(true); // 미전송 → 변경 없음
    });
  });
});
