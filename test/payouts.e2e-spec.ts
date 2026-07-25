import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, mondayISO, addDaysISO } from "./setup-app";

// TBO-05 시수 측정·페이 정산 e2e.
// 시나리오(요구 #5): 스케줄 생성 → 수업 진행(held)+report 승인 → 수업 취소 →
//                    시수 측정·페이 산정 → 실제 값 검증. 모두 mock-data·HTTP로 진행.
//
// 시급(courses 시드): 코스10=50,000원/h, 코스12=45,000원/h (강사1).
// 적격 게이트: status==='held' ∧ 승인된 보고서 존재 ∧ 코스 FK 유효 ∧ 미연결.
describe("Payouts — 시수 측정·페이 정산 (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const MON = mondayISO();
  const SUN = addDaysISO(MON, 6);
  const TUE = addDaysISO(MON, 1);
  const INSTRUCTOR = 1;
  const STUDENT = 1;

  // 관리자 액션은 RolesGuard(super_admin/manager/admin) 보호 → 데모 admin 토큰으로 호출.
  let ADMIN = "";
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    const login = await http.post("/api/auth/login").send({ webId: "admin", password: "demo1234" }).expect(201);
    ADMIN = login.body.accessToken;
  });
  afterAll(async () => {
    await app.close();
  });

  // 세션 생성 헬퍼(충돌 무시 force) → id 반환
  async function makeSession(courseId: number, startTime: string, durationMinutes: number): Promise<number> {
    const res = await http
      .post("/api/schedule")
      .set(asAdmin())
      .send({ courseId, instructorId: INSTRUCTOR, studentIds: [STUDENT], sessionDate: TUE, startTime, durationMinutes, force: true })
      .expect(201);
    return res.body.row.id;
  }
  async function setStatus(id: number, status: string): Promise<void> {
    // [TBO-66 C1] 리포트 승인이 세션을 held로 자동 확정 — 이후 취소 전환은 회계 영향 ack 필요(정합)
    await http.patch(`/api/schedule/${id}`).set(asAdmin()).send({ status, force: true, acknowledgeAccountingImpact: true }).expect(200);
  }
  // 보고서 작성(submitted) → 반환 id
  async function makeReport(sessionId: number): Promise<number> {
    const res = await http
      .post("/api/reports")
      .set(asAdmin())
      .send({ sessionId, studentId: STUDENT, content: "진도/피드백 본문" })
      .expect(201);
    expect(res.body.status).toBe("submitted");
    return res.body.id;
  }

  // 시나리오용 세션 묶음(강사1, 화요일)
  let S1 = 0; // 코스10 90분 — held + 보고서 승인 → 적격(75,000)
  let S2 = 0; // 코스12 120분 — held + 보고서 승인 → 적격(90,000)
  let S3 = 0; // 코스10 60분 — held, 보고서 없음 → 제외(승인 미충족)
  let S4 = 0; // 코스10 60분 — held, 보고서 제출만(미승인) → 제외
  let S5 = 0; // 코스10 90분 — 취소(canceled) + 보고서 승인 → 제외(미진행)

  it("1) 스케줄 생성 — 강사1 화요일 5개 세션(빈 슬롯)", async () => {
    S1 = await makeSession(10, "09:00", 90);
    S2 = await makeSession(12, "11:00", 120);
    S3 = await makeSession(10, "14:00", 60);
    S4 = await makeSession(10, "15:00", 60);
    S5 = await makeSession(10, "16:30", 90);
    expect([S1, S2, S3, S4, S5].every((id) => id > 0)).toBe(true);
  });

  it("2) 수업 진행(held) + 보고서 작성·승인", async () => {
    // 진행 처리
    for (const id of [S1, S2, S3, S4]) await setStatus(id, "held");
    // [기간설정 ① 2026-07-24] 학생 출결 기록 — 미기록도 '이상'(attendance_missing → 직접 입력)이라
    //  auto 적격이 되려면 출결까지 완결돼야 한다(실운영 흐름과 동일: 출결 → 리포트 → 승인).
    for (const id of [S1, S2]) {
      await http.put("/api/attendance").set(asAdmin())
        .send({ sessionId: id, studentId: STUDENT, status: "present" }).expect(200);
    }
    // S1·S2 보고서 작성 → 승인
    const r1 = await makeReport(S1);
    const r2 = await makeReport(S2);
    await http
      .post(`/api/reports/${r1}/approve`)
      .set(asAdmin())
      .expect(201)
      .then((res) => expect(res.body.approvalStatus).toBe("approved"));
    await http.post(`/api/reports/${r2}/approve`).set(asAdmin()).expect(201);
    // S4 보고서는 제출만(미승인)
    await makeReport(S4);
    // S3 보고서 없음(작성하지 않음)
  });

  it("3) 수업 취소 발생 — S5는 보고서 승인돼도 취소면 시수 제외", async () => {
    const r5 = await makeReport(S5);
    await http.post(`/api/reports/${r5}/approve`).set(asAdmin()).expect(201);
    await setStatus(S5, "canceled"); // 진행되지 않음 → 시수 0
  });

  it("4) 시수 측정(preview) — held∧승인보고서만 집계, 취소·미승인·무보고 제외", async () => {
    const m = (await http.get(`/api/payouts/preview?instructorId=${INSTRUCTOR}&from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    // 적격은 S1, S2 두 건뿐
    expect(m.sessionCount).toBe(2);
    expect(m.totalMinutes).toBe(210); // 90 + 120
    expect(m.computedAmount).toBe(165000); // 75,000 + 90,000
    const ids = m.lines.map((l: { sessionId: number }) => l.sessionId).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([S1, S2].sort((a, b) => a - b));
    // 라인별 시급 조인·산정 검증
    const l1 = m.lines.find((l: { sessionId: number }) => l.sessionId === S1);
    expect(l1).toMatchObject({ hourlyRate: 50000, durationMinutes: 90, amount: 75000 });
    const l2 = m.lines.find((l: { sessionId: number }) => l.sessionId === S2);
    expect(l2).toMatchObject({ hourlyRate: 45000, durationMinutes: 120, amount: 90000 });
  });

  it("5) 페이 산정(generate) — 정산서 생성 + 세션 연결, 값 일치", async () => {
    const p = (
      await http.post("/api/payouts/generate").set(asAdmin()).send({ instructorId: INSTRUCTOR, from: MON, to: SUN }).expect(201)
    ).body;
    expect(p.status).toBe("pending");
    expect(p.sessionCount).toBe(2);
    expect(p.totalMinutes).toBe(210);
    expect(p.computedAmount).toBe(165000);
    expect(p.amount).toBe(165000);
    // 연결된 세션은 instructorPayAmount 스냅샷 보유
    const s1 = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body.find(
      (r: { id: number }) => r.id === S1,
    );
    expect(s1.payoutId).toBe(p.id);
    expect(s1.instructorPayAmount).toBe(75000);
  });

  it("6) 이중 계상 방지 — 같은 기간 재산정 시 적격 0 → generate 400", async () => {
    const m = (await http.get(`/api/payouts/preview?instructorId=${INSTRUCTOR}&from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    expect(m.sessionCount).toBe(0); // 이미 연결됨
    await http.post("/api/payouts/generate").set(asAdmin()).send({ instructorId: INSTRUCTOR, from: MON, to: SUN }).expect(400);
  });

  it("7) 관리자 반려(reject) — 정산서 rejected + 세션 회수(재산정 가능)", async () => {
    const list = (await http.get("/api/payouts").set(asAdmin()).expect(200)).body;
    const target = list.find((x: { status: string }) => x.status === "pending");
    const rejected = (
      await http.post(`/api/payouts/${target.id}/reject`).set(asAdmin()).send({ reason: "근태 확인 필요" }).expect(201)
    ).body;
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedReason).toBe("근태 확인 필요");
    // 세션 회수됨 → 다시 적격 2건
    const m = (await http.get(`/api/payouts/preview?instructorId=${INSTRUCTOR}&from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    expect(m.sessionCount).toBe(2);
  });

  it("8) 관리자 급여 수정(adjust) — 자동 산정액 보존, 실효 지급액만 변경", async () => {
    const p = (
      await http.post("/api/payouts/generate").set(asAdmin()).send({ instructorId: INSTRUCTOR, from: MON, to: SUN }).expect(201)
    ).body;
    const adj = (
      await http.post(`/api/payouts/${p.id}/adjust`).set(asAdmin()).send({ amount: 150000, reason: "교통비 차감" }).expect(201)
    ).body;
    expect(adj.computedAmount).toBe(165000); // 기준 보존
    expect(adj.adjustedAmount).toBe(150000);
    expect(adj.amount).toBe(150000); // 실효 지급액
    expect(adj.adjustReason).toBe("교통비 차감");
  });

  it("9) 확정→지급(pay) — 통합 원장 출금 1줄 기록, 금액=실효 지급액", async () => {
    const list = (await http.get("/api/payouts").set(asAdmin()).expect(200)).body;
    const p = list.find((x: { status: string }) => x.status === "pending");
    // 지급 전 확정 필요
    await http.post(`/api/payouts/${p.id}/pay`).set(asAdmin()).expect(400); // confirmed 아니면 거부
    await http
      .post(`/api/payouts/${p.id}/confirm`)
      .set(asAdmin())
      .expect(201)
      .then((res) => expect(res.body.status).toBe("confirmed"));
    const paid = (await http.post(`/api/payouts/${p.id}/pay`).set(asAdmin()).expect(201)).body;
    expect(paid.payout.status).toBe("paid");
    expect(paid.payout.paidAt).toBeTruthy();
    expect(paid.transaction).toMatchObject({ direction: "out", category: "instructor_payout", amount: 150000, payoutId: p.id });
  });

  // ── 참조 무결성(FK)·검증 ──
  it("FK: 존재하지 않는 sessionId로 보고서 작성 → 400", async () => {
    await http.post("/api/reports").set(asAdmin()).send({ sessionId: 999999, studentId: STUDENT, content: "x" }).expect(400);
  });

  it("중복 방지: 같은 (세션·학생) 보고서 재작성 → 409", async () => {
    await http.post("/api/reports").set(asAdmin()).send({ sessionId: S1, studentId: STUDENT, content: "중복" }).expect(409);
  });

  it("검증: 잘못된 기간(from>to) → 400", async () => {
    await http.get(`/api/payouts/preview?instructorId=${INSTRUCTOR}&from=${SUN}&to=${MON}`).set(asAdmin()).expect(400);
  });

  // ── RolesGuard 인가(TBO-21) — 정산 전체 생성/확정/지급은 super_admin 전용 ──
  it("인가: 비로그인으로 정산서 생성 → 401", async () => {
    await http.post("/api/payouts/generate").send({ instructorId: INSTRUCTOR, from: MON, to: SUN }).expect(401);
  });

  it("인가: 강사(instructor) 토큰으로 정산서 생성 → 403", async () => {
    const login = await http.post("/api/auth/login").send({ webId: "park_inst", password: "demo1234" }).expect(201);
    await http
      .post("/api/payouts/generate")
      .set({ Authorization: `Bearer ${login.body.accessToken}` })
      .send({ instructorId: INSTRUCTOR, from: MON, to: SUN })
      .expect(403);
  });

  it("[통신 감사 2026-07-03] 인가: 읽기(GET /payouts)도 로그인 필수 — 비로그인 401(급여 노출 차단)", async () => {
    await http.get("/api/payouts").expect(401);
    await http.get("/api/payouts").set(asAdmin()).expect(200);
  });
});
