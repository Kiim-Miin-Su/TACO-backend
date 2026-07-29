// [TBO-67 2026-07-26] 예상 유저 여정 e2e — **복잡한 흐름 + 역할 교차**를 실제 사용 순서 그대로 고정.
//  문서 짝: docs/USER-FLOWS-2026-07.md(여정 서사·권한 표) · CODEX.md(리뷰 체크리스트) — 세 문서가
//  같은 여정 ID(J1/J2/J3)를 공유한다. 각 단계는 "누가(토큰) 무엇을" 순서로 — 권한 위반 지점을
//  여정 중간에 심어 방어선(403/400/409)이 흐름 안에서 실제로 작동함을 검증한다.
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, mondayISO, addDaysISO, sudoAuthHeaders } from './setup-app';

jest.setTimeout(20000); // 여정 스위트 — 단계 수가 많다(풀런 부하 대비)
// 상태를 여러 it에 걸쳐 이어가는 유기 여정은 개별 it retry가 이전 시도의 DB 변경을 승계해
// report duplicate 409 등 거짓 실패를 만든다. 이 스위트는 최초 실패를 그대로 노출한다.
jest.retryTimes(0);

describe('[TBO-67] 유저 여정 (e2e)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const as = (who: string) => sudoAuthHeaders(app, tokens[who]);
  // 2주 전 월·화 — 주의: 픽스처 비시리즈 세션은 절대 날짜(6~7월 고정)라 실행 주에 따라 이 기간과
  //  겹칠 수 있다(실측: 07-06 강사1 late 미책정 행이 침입해 totals 절대값 단언이 깨졌다).
  //  → J2의 합계 단언은 전부 "①에서 캡처한 기준선 + Δ"로 작성한다(날짜 회피는 주가 바뀌면 재발).
  const J2DAY = addDaysISO(mondayISO(), -14);
  const J2DAY2 = addDaysISO(mondayISO(), -13);

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const webId of ['admin', 'manager', 'park_inst', 'jung_inst']) {
      tokens[webId] = (await http.post('/api/auth/login').send({ webId, password: 'demo1234' }).expect(201)).body.accessToken;
    }
  });
  afterAll(async () => { await app.close(); });

  // ── J1 · 학생 입회 여정: 등록(매니저) → 상담 → 수강 → 청구·수납(대표) ──
  describe('J1 학생 입회 — 매니저가 만들고 대표가 수납한다', () => {
    let studentId = 0;
    let enrollmentId = 0;
    let paymentId = 0;
    const student = {
      name: 'J1 여정학생', gender: 'female', birthDate: '2013-05-02', grade: 7, country: 'KR',
      residenceType: 'domestic', address: '서울시 서초구', schoolName: 'Journey School',
      phone: '010-9310-7788', counselTopic: '입회 상담', status: 'new_inquiry',
    };
    const interests = [{ courseId: 12, priority: 1 }, { customLabel: 'Debate', priority: 2 }];

    it('① (매니저) 원자 등록 — 학생+보호자+audit 단일 tx · (강사) 등록은 403', async () => {
      await http.post('/api/students/registrations').set(as('park_inst'))
        .send({ student, interests }).expect(403); // 학생 CRUD = 매니저 이상(강사는 열람 스코프만)
      const created = (await http.post('/api/students/registrations').set(as('manager'))
        .send({ student, interests, guardians: [{ name: 'J1 보호자', phone: '010-9310-7789', relation: '모', isPayer: true, isPrimary: true }] })
        .expect(201)).body;
      studentId = created.student.id;
      expect(created.guardians).toHaveLength(1);
    });

    it('② (매니저) 상담 폼·회차 기록 → 등록 전환 · (강사) 상담은 전면 403', async () => {
      await http.post('/api/counsel').set(as('park_inst')).send({ studentId }).expect(403);
      const form = (await http.post('/api/counsel').set(as('manager')).send({ studentId }).expect(201)).body;
      expect(form).toMatchObject({ assignedStaffId: 4, source: 'manual', submitterType: 'staff' });
      const round = (await http.post(`/api/counsel/${form.id}/rounds`).set(as('manager'))
        .send({
          summary: '레벨 테스트 안내',
          result: 'positive',
          nextContactAt: `${addDaysISO(mondayISO(), 3)}T00:00:00.000Z`,
        }).expect(201)).body;
      expect(round.counselorId).toBe(4);
      const updated = (await http.patch(`/api/counsel/${form.id}`).set(as('manager')).send({ status: 'registered' }).expect(200)).body;
      expect(updated.status).toBe('registered');
    });

    it('③ (매니저) 수강 등록 → 중복 재등록 409(방어가 여정 중간에서 작동)', async () => {
      const enrollment = (await http.post('/api/enrollments').set(as('manager'))
        .send({ studentId, courseId: 12, totalSessions: 8 }).expect(201)).body;
      enrollmentId = enrollment.id;
      await http.post('/api/enrollments').set(as('manager')).send({ studentId, courseId: 12 }).expect(409);
    });

    it('④ (대표) 청구 생성 → 수납 — 원장 입금 1줄 · (매니저) 재무는 403', async () => {
      await http.post('/api/payments').set(as('manager')).send({ studentId, amount: 300000 }).expect(403); // 재무 = 대표 전용
      const payment = (await http.post('/api/payments').set(as('admin'))
        .send({ studentId, enrollmentId, amount: 300000, dueAt: addDaysISO(mondayISO(), 7) }).expect(201)).body;
      paymentId = payment.id;
      const paid = (await http.post(`/api/payments/${paymentId}/pay`).set(as('admin')).expect(201)).body;
      expect(paid.status).toBe('paid');
      const ledger = (await http.get('/api/transactions').set(as('admin')).expect(200)).body as Array<{ paymentId?: number; direction: string; amount: number }>;
      const tx = ledger.find((t) => t.paymentId === paymentId);
      expect(tx).toMatchObject({ direction: 'in', amount: 300000 });
      await http.post(`/api/payments/${paymentId}/pay`).set(as('admin')).expect(400); // 이중 수납 차단
    });
  });

  // ── J2 · 시수·정산 여정: 강사 사실 기록 → 매니저 운영 승인 → 대표 금액 확정·지급·회수 ──
  describe('J2 수업→출결→리포트→워크시트→정산 — 3역할 교차', () => {
    let S1 = 0; // 정상 진행 회차(강사 셀프 출결·리포트 승인 → auto)
    let S2 = 0; // 지각 회차(매니저 책정 필요 → 직접 int 입력)
    let payoutId = 0;
    let payoutAmount = 0; // ⑤에서 생성된 정산 총액(기준선 포함) — ⑥ me 목록 검증에 재사용
    let baseline: { autoAmount: number; manualAmount: number; totalAmount: number; unpricedCount: number };
    const worksheet = (who: string) =>
      http.get(`/api/payouts/worksheet?instructorId=1&from=${J2DAY}&to=${J2DAY2}`).set(as(who));

    it('① (매니저) 과거 회차 2개 개설 — scheduled로 시작', async () => {
      baseline = (await worksheet('admin').expect(200)).body.totals; // 금액 워크시트는 대표 전용
      for (const [day, time] of [[J2DAY, '10:00'], [J2DAY2, '10:00']] as const) {
        const res = await http.post('/api/schedule').set(as('manager'))
          .send({ courseId: 10, instructorId: 1, studentIds: [1], sessionDate: day, startTime: time, durationMinutes: 60, force: true })
          .expect(201);
        if (day === J2DAY) S1 = res.body.row.id; else S2 = res.body.row.id;
        expect(res.body.row.status).toBe('scheduled');
      }
    });

    it('② (강사) 본인 출결 셀프 체크 → 학생 출결 전 scheduled · 타인/재체크 403', async () => {
      await http.post(`/api/schedule/${S1}/instructor-attendance`).set(as('jung_inst')).send({ status: 'present' }).expect(403); // 타인 세션
      await http.post(`/api/schedule/${S1}/instructor-attendance`).set(as('park_inst')).send({ status: 'present' }).expect(201);
      expect((await http.get(`/api/schedule/${S1}`).set(as('manager')).expect(200)).body.status).toBe('scheduled');
      await http.post(`/api/schedule/${S1}/instructor-attendance`).set(as('park_inst')).send({ status: 'late' }).expect(403); // 수정은 매니저만
    });

    it('③ (강사) 학생 출결 + 리포트 제출 → (매니저) 미승인 동안 워크시트는 빈칸(직접 입력 대상)', async () => {
      await http.put('/api/attendance').set(as('park_inst')).send({ sessionId: S1, studentId: 1, status: 'present' }).expect(200);
      expect((await http.get(`/api/schedule/${S1}`).set(as('manager')).expect(200)).body.status).toBe('held');
      const report = (await http.post('/api/reports').set(as('park_inst'))
        .send({ sessionId: S1, studentId: 1, content: 'J2 수업 요약', status: 'submitted' }).expect(201)).body;
      await http.post(`/api/reports/${report.id}/approve`).set(as('park_inst')).expect(403); // 승인은 매니저 이상
      const ws = (await worksheet('admin').expect(200)).body;
      const row1 = ws.rows.find((r: { sessionId: number }) => r.sessionId === S1);
      expect(row1.pricing.kind).toBe('manual'); // 리포트 미승인 = 이상 → 빈칸
      expect(row1.pricing.manualReasons).toContain('report_incomplete');
      await worksheet('manager').expect(403); // 금액 워크시트는 대표 전용
      await worksheet('park_inst').expect(403);
      // (매니저) 승인 → auto 전환(시급 5만×1h = 5만)
      await http.post(`/api/reports/${report.id}/approve`).set(as('manager')).expect(201);
      const after = (await worksheet('admin').expect(200)).body;
      const row1b = after.rows.find((r: { sessionId: number }) => r.sessionId === S1);
      expect(row1b.pricing).toMatchObject({ kind: 'auto', effectiveAmount: 50000 });
    });

    it('④ (매니저 운영 처리 → 대표 금액 책정) 지각 회차 — 빈칸을 대표가 정수로 확정', async () => {
      await http.patch(`/api/schedule/${S2}`).set(as('manager')).send({ instructorAttendance: 'late', force: true }).expect(200); // 자동 held
      await http.put('/api/attendance').set(as('manager')).send({ sessionId: S2, studentId: 1, status: 'present' }).expect(200);
      const report = (await http.post('/api/reports').set(as('manager'))
        .send({ sessionId: S2, studentId: 1, instructorId: 1, content: 'J2 지각 회차', status: 'submitted' }).expect(201)).body;
      await http.post(`/api/reports/${report.id}/approve`).set(as('manager')).expect(201);
      const ws = (await worksheet('admin').expect(200)).body;
      const row2 = ws.rows.find((r: { sessionId: number }) => r.sessionId === S2);
      expect(row2.pricing.kind).toBe('manual');
      expect(row2.pricing.manualReasons).toContain('late');
      await http.put(`/api/schedule/${S2}/pay-amount`).set(as('park_inst')).send({ amount: 30000 }).expect(403);
      await http.put(`/api/schedule/${S2}/pay-amount`).set(as('manager')).send({ amount: 30000 }).expect(403);
      await http.put(`/api/schedule/${S2}/pay-amount`).set(as('admin')).send({ amount: 30500.5 }).expect(400);
      await http.put(`/api/schedule/${S2}/pay-amount`).set(as('admin')).send({ amount: 30000 }).expect(200);
      const priced = (await worksheet('admin').expect(200)).body;
      // Δ 단언(기준선 상대) — auto 5만(S1) + 수기 3만(S2), 이 여정발 미책정 잔존 0
      expect(priced.totals.autoAmount).toBe(baseline.autoAmount + 50000);
      expect(priced.totals.manualAmount).toBe(baseline.manualAmount + 30000);
      expect(priced.totals.totalAmount).toBe(baseline.totalAmount + 80000);
      expect(priced.totals.unpricedCount).toBe(baseline.unpricedCount);
    });

    it('⑤ (대표) 정산 생성→확정→지급 — 원장 출금·세션 지급 스탬프 · (매니저) 생성은 403', async () => {
      await http.post('/api/payouts/generate').set(as('manager'))
        .send({ instructorId: 1, from: J2DAY, to: J2DAY2 }).expect(403); // 정산서 생성은 대표 전용
      const payout = (await http.post('/api/payouts/generate').set(as('admin'))
        .send({ instructorId: 1, from: J2DAY, to: J2DAY2 }).expect(201)).body;
      payoutId = payout.id;
      payoutAmount = payout.amount;
      expect(payoutAmount).toBe(baseline.totalAmount + 80000); // auto 5만 + 책정 3만 (+기준선 확정분)
      await http.put(`/api/schedule/${S2}/pay-amount`).set(as('admin')).send({ amount: 40000 }).expect(409); // 연결 후 가격 변경 차단
      await http.post(`/api/payouts/${payoutId}/confirm`).set(as('admin')).expect(201);
      const paid = (await http.post(`/api/payouts/${payoutId}/pay`).set(as('admin')).expect(201)).body;
      expect(paid.transaction).toMatchObject({ direction: 'out', amount: payoutAmount });
    });

    it('⑥ (강사) 지급 완료 요약만 열람 — 단건 상세는 403, 회수되면 목록에서도 사라진다', async () => {
      const mine = (await http.get('/api/payouts/me').set(as('park_inst')).expect(200)).body as Array<{ id: number; status: string; amount: number }>;
      expect(mine.some((p) => p.id === payoutId && p.status === 'paid' && p.amount === payoutAmount)).toBe(true);
      await http.get(`/api/payouts/${payoutId}`).set(as('park_inst')).expect(403); // 상세내역 불가(기간설정 ②)
      // (대표) 지급 회수 — 보상 원장 + 세션 회수
      await http.post(`/api/payouts/${payoutId}/reverse`).set(as('admin')).send({ reason: 'J2 회수 검증' }).expect(201);
      const after = (await http.get('/api/payouts/me').set(as('park_inst')).expect(200)).body as Array<{ id: number }>;
      expect(after.some((p) => p.id === payoutId)).toBe(false); // paid만 노출 — 회수분 비노출
      // 회수 후 재산정 — 사용자 수기 책정가는 보존되고 payoutId만 해제된다(TBO-73).
      // 정산 snapshot(lines)과 회차 override(instructorPayAmount)의 역할을 섞지 않는다.
      const remeasure = (await http.get(`/api/payouts/preview?instructorId=1&from=${J2DAY}&to=${J2DAY2}`).set(as('admin')).expect(200)).body;
      expect(remeasure.computedAmount).toBe(payoutAmount);
    });
  });

  // ── J3 · 권한 매트릭스 스윕: 같은 자원에 3역할 — 화면 게이트와 서버 인가의 정합 표 ──
  describe('J3 권한 매트릭스 — 대표/매니저/강사', () => {
    const CASES: Array<[string, () => request.Test, number, number, number]> = [
      // [자원, 요청, 대표, 매니저, 강사] — USER-FLOWS §4 표와 1:1
      ['정산 목록', () => http.get('/api/payouts'), 200, 403, 403],
      ['정산 준비상태', () => http.get('/api/payouts/readiness'), 200, 200, 403],
      ['미정산 감지', () => http.get('/api/payouts/uncovered'), 200, 403, 403],
      ['지출 목록', () => http.get('/api/expenses'), 200, 403, 403],
      ['원장', () => http.get('/api/transactions'), 200, 403, 403],
      ['수납 목록', () => http.get('/api/payments'), 200, 403, 403],
      ['학생 목록', () => http.get('/api/students'), 200, 200, 200], // 강사=본인 코호트 스코프(축소 응답)
      ['상담 목록', () => http.get('/api/counsel'), 200, 200, 403],
      ['수업 목록', () => http.get('/api/schedule'), 200, 200, 200],
      ['프리셋 목록', () => http.get('/api/view-presets'), 200, 200, 200],
    ];
    it('열람 매트릭스가 문서 표와 일치한다', async () => {
      for (const [label, make, ceo, mgr, inst] of CASES) {
        expect([(await make().set(as('admin'))).status, label + ':대표']).toEqual([ceo, label + ':대표']);
        expect([(await make().set(as('manager'))).status, label + ':매니저']).toEqual([mgr, label + ':매니저']);
        expect([(await make().set(as('park_inst'))).status, label + ':강사']).toEqual([inst, label + ':강사']);
      }
    });
    it('강사 me 라우트는 강사 전용(관리자는 관리 표면 사용)', async () => {
      await http.get('/api/payouts/me').set(as('park_inst')).expect(200);
      await http.get('/api/payouts/me').set(as('manager')).expect(403);
      await http.get('/api/payouts/me').set(as('admin')).expect(403);
    });
  });
});
