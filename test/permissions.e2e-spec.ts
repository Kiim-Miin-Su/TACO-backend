import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./setup-app";

// 권한 매트릭스 e2e (#6) — 데모 역할별 토큰으로 주요 엔드포인트 호출 → 기대 응답 검증.
// 가드 현황(2026-07-03): /auth/pending·approve·reject = super_admin 전용.
// schedule·reports 읽기 = 로그인(STAFF). payouts 읽기 = 관리자 전용(M1 상향).
// conflicts 드라이런·users/exists = 로그인 필수(H1·H2 — @Roles 누락 무인증 개방 수정).
describe("Permission matrix (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
  });

  // 데모 시드 계정(비번 demo1234)
  const ACCOUNTS: Record<string, string> = { super_admin: "admin", manager: "manager", instructor: "park_inst" };
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    for (const [role, webId] of Object.entries(ACCOUNTS)) {
      const res = await http.post("/api/auth/login").send({ webId, password: "demo1234" }).expect(201);
      tokens[role] = res.body.accessToken;
    }
  });

  const auth = (role?: string) => (role ? { Authorization: `Bearer ${tokens[role]}` } : {});

  describe("super_admin 전용 — /auth/pending", () => {
    it("super_admin → 200", async () => {
      await http.get("/api/auth/pending").set(auth("super_admin")).expect(200);
    });
    it("manager → 403", async () => {
      await http.get("/api/auth/pending").set(auth("manager")).expect(403);
    });
    it("instructor → 403", async () => {
      await http.get("/api/auth/pending").set(auth("instructor")).expect(403);
    });
    it("토큰 없음 → 401", async () => {
      await http.get("/api/auth/pending").expect(401);
    });
  });

  describe("super_admin 전용 — /auth/approve/:id (가드가 핸들러보다 먼저)", () => {
    it("manager → 403 (id 무관)", async () => {
      await http.post("/api/auth/approve/999").set(auth("manager")).send({}).expect(403);
    });
    it("토큰 없음 → 401", async () => {
      await http.post("/api/auth/approve/999").send({}).expect(401);
    });
  });

  describe("읽기(GET) — 로그인 역할 공통 개방(스태프)", () => {
    const open = ["/api/schedule", "/api/reports", "/api/schedule/resources"];
    for (const role of Object.keys(ACCOUNTS)) {
      for (const path of open) {
        it(`${role} → GET ${path} 200`, async () => {
          await http.get(path).set(auth(role)).expect(200);
        });
      }
    }
  });

  // [코드리뷰 2026-07-03 M1] 정산 조회는 관리자 전용으로 상향 — 강사가 타 강사 정산액·시급 열람 차단.
  describe("정산 읽기(GET /payouts) — 관리자 전용", () => {
    it("super_admin → 200", async () => {
      await http.get("/api/payouts").set(auth("super_admin")).expect(200);
    });
    it("manager → 200", async () => {
      await http.get("/api/payouts").set(auth("manager")).expect(200);
    });
    it("instructor → 403 (수평 권한 차단)", async () => {
      await http.get("/api/payouts").set(auth("instructor")).expect(403);
    });
    it("instructor → GET /payouts/preview 403", async () => {
      await http
        .get("/api/payouts/preview")
        .query({ instructorId: 1, from: "2026-07-01", to: "2026-07-31" })
        .set(auth("instructor"))
        .expect(403);
    });
    it("토큰 없음 → 401", async () => {
      await http.get("/api/payouts").expect(401);
    });
  });

  // [TBO-16 #8] 수업 배정·변경·삭제 = manager 이상. 강사는 schedule-requests(승인 흐름)로만.
  describe("수업 쓰기 manager 이상 — 강사 403·요청 경로 개방", () => {
    const body = { courseId: 10, sessionDate: "2099-03-02", startTime: "10:00", endTime: "11:00" };
    it("instructor → POST /schedule 403 (직접 배정 차단)", async () => {
      await http.post("/api/schedule").set(auth("instructor")).send(body).expect(403);
    });
    it("instructor → PATCH /schedule/1 403 · DELETE /schedule/1 403", async () => {
      await http.patch("/api/schedule/1").set(auth("instructor")).send({ startTime: "11:00" }).expect(403);
      await http.delete("/api/schedule/1").set(auth("instructor")).expect(403);
    });
    it("instructor → POST /schedule-requests 201 (요청 경로는 개방)", async () => {
      const res = await http.post("/api/schedule-requests").set(auth("instructor")).send(body).expect(201);
      expect(res.body.row.status).toBe("pending");
    });
    it("manager → POST /schedule 201 (관리자 직접 배정 유지)", async () => {
      const res = await http.post("/api/schedule").set(auth("manager")).send({ ...body, sessionDate: "2099-03-03", force: true }).expect(201);
      expect(res.body.row.id).toBeGreaterThan(0);
    });
  });

  // [코드리뷰 2026-07-03 H1·H2] @Roles 누락으로 무인증 개방됐던 라우트 — 로그인 필수 회귀 방지.
  describe("무가드 회귀 방지 — conflicts 드라이런·users/exists 로그인 필수", () => {
    it("토큰 없음 → POST /schedule/conflicts 401", async () => {
      await http
        .post("/api/schedule/conflicts")
        .send({ sessionDate: "2026-07-06", startTime: "10:00", endTime: "11:00", instructorId: 1, roomId: 1 })
        .expect(401);
    });
    it("instructor → POST /schedule/conflicts 통과(401/403 아님)", async () => {
      const res = await http
        .post("/api/schedule/conflicts")
        .set(auth("instructor"))
        .send({ sessionDate: "2026-07-06", startTime: "10:00", endTime: "11:00", instructorId: 1, roomId: 1 });
      expect([401, 403]).not.toContain(res.status);
    });
    it("토큰 없음 → GET /users/exists 401", async () => {
      await http.get("/api/users/exists").query({ webId: "admin" }).expect(401);
    });
    it("manager → GET /users/exists 200", async () => {
      await http.get("/api/users/exists").query({ webId: "admin" }).set(auth("manager")).expect(200);
    });
  });

  // 백오피스 쓰기 액션은 RolesGuard(super_admin/manager/admin) 전용.
  // 가드가 핸들러보다 먼저 실행되므로 id가 유효하지 않아도 인가 결과(403/401)가 먼저 나온다.
  describe("RolesGuard — 관리자 전용 쓰기 액션 거부", () => {
    const adminWrites = ["/api/payouts/999/confirm", "/api/reports/999/approve", "/api/expenses/999/approve"];
    for (const path of adminWrites) {
      it(`instructor → POST ${path} 403`, async () => {
        await http.post(path).set(auth("instructor")).send({}).expect(403);
      });
      it(`토큰 없음 → POST ${path} 401`, async () => {
        await http.post(path).send({}).expect(401);
      });
      it(`manager → POST ${path} 통과(가드 허용, 403/401 아님)`, async () => {
        const res = await http.post(path).set(auth("manager")).send({});
        expect([401, 403]).not.toContain(res.status); // 인가 통과 → 이후 핸들러 결과(예: 404/400)
      });
    }
  });
});
