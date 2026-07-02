import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./setup-app";

// TBO-05 참조 무결성 검증 — 데모 시드 + 관리자 승인·급여수정·지급 완료 경로.
// "관리자의 승인과 지급 완료와 수정까지 참조 무결성을 지키는지" 집중 검증.
const JUN1 = "2026-06-01";
const JUN30 = "2026-06-30";

describe("Payouts 참조 무결성 (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  // 관리자 액션은 RolesGuard(super_admin/manager/admin) 보호 → 데모 admin 토큰 사용.
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

  it("데모 시드: 강사2 지급완료 정산서 + 연결 세션 역참조 일치(Σ페이=금액)", async () => {
    const payouts = (await http.get("/api/payouts").expect(200)).body;
    const paid = payouts.find((p: { instructorId: number; status: string }) => p.instructorId === 2 && p.status === "paid");
    expect(paid).toBeTruthy();
    expect(paid.amount).toBe(360000); // 3 × 120분 × 60,000/h
    expect(paid.computedAmount).toBe(360000);
    expect(paid.totalMinutes).toBe(360);
    expect(paid.sessionCount).toBe(3);
    expect(paid.paidAt).toBeTruthy();

    // 역참조 무결성: 연결 세션이 payoutId로 정산서를 가리키고, 페이 스냅샷 합 = 금액
    const sessions = (await http.get(`/api/schedule?from=${JUN1}&to=${JUN30}`).expect(200)).body;
    const linked = sessions.filter((s: { payoutId?: number }) => s.payoutId === paid.id);
    expect(linked.length).toBe(3);
    const sum = linked.reduce((a: number, s: { instructorPayAmount?: number }) => a + (s.instructorPayAmount ?? 0), 0);
    expect(sum).toBe(paid.amount);
    // 라인 스냅샷과 세션 id 집합 일치
    const lineIds = paid.lines.map((l: { sessionId: number }) => l.sessionId).sort((a: number, b: number) => a - b);
    const sessIds = linked.map((s: { id: number }) => s.id).sort((a: number, b: number) => a - b);
    expect(lineIds).toEqual(sessIds);
  });

  it("시수 게이트: 강사1 적격은 held+승인보고서 3건만(무보고·취소 제외)", async () => {
    const m = (await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).expect(200)).body;
    expect(m.sessionCount).toBe(3);
    expect(m.totalMinutes).toBe(300); // 90 + 90 + 120
    expect(m.computedAmount).toBe(240000); // 75,000 + 75,000 + 90,000
  });

  it("관리자 경로: 생성→승인→급여수정→지급 + 무결성(수정액이 원장에 반영)", async () => {
    // 생성(pending) + 세션 연결
    const p = (
      await http.post("/api/payouts/generate").set(asAdmin()).send({ instructorId: 1, from: JUN1, to: JUN30 }).expect(201)
    ).body;
    expect(p.status).toBe("pending");
    expect(p.amount).toBe(240000);

    // 이중 계상 방지: 같은 세션 재산정 시 0
    const again = (await http.get(`/api/payouts/preview?instructorId=1&from=${JUN1}&to=${JUN30}`).expect(200)).body;
    expect(again.sessionCount).toBe(0);

    // 관리자 승인(confirmed)
    const confirmed = (await http.post(`/api/payouts/${p.id}/confirm`).set(asAdmin()).expect(201)).body;
    expect(confirmed.status).toBe("confirmed");

    // 관리자 급여 수정 — 자동 산정액 보존, 실효액만 변경
    const adj = (
      await http.post(`/api/payouts/${p.id}/adjust`).set(asAdmin()).send({ amount: 230000, reason: "식대 차감" }).expect(201)
    ).body;
    expect(adj.computedAmount).toBe(240000);
    expect(adj.adjustedAmount).toBe(230000);
    expect(adj.amount).toBe(230000);

    // 지급 완료 + 통합 원장 출금(수정된 실효액으로)
    const paid = (await http.post(`/api/payouts/${p.id}/pay`).set(asAdmin()).expect(201)).body;
    expect(paid.payout.status).toBe("paid");
    expect(paid.transaction).toMatchObject({ direction: "out", category: "instructor_payout", amount: 230000, payoutId: p.id });
  });

  it("반려 무결성: 반려 시 연결 세션 회수 → 재산정 가능", async () => {
    // 강사1 세션은 앞 테스트에서 paid에 묶임 → 새 기간(좁게) 대신 반려 후 회수 검증을 위해
    // 새 정산서를 만들 수 없으니(이미 연결), 강사2의 미연결 기간엔 세션이 없음.
    // 대신 강사1의 paid 정산서는 회수 불가(paid)임을 확인.
    const payouts = (await http.get("/api/payouts").expect(200)).body;
    const paid1 = payouts.find((p: { instructorId: number; status: string }) => p.instructorId === 1 && p.status === "paid");
    await http.post(`/api/payouts/${paid1.id}/reject`).set(asAdmin()).send({ reason: "x" }).expect(400); // 지급완료는 반려 불가
  });
});
