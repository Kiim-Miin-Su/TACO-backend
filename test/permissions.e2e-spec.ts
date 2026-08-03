import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, sudoAuthHeaders } from "./setup-app";

// 권한 매트릭스 e2e (#6) — 데모 역할별 토큰으로 주요 엔드포인트 호출 → 기대 응답 검증.
// 가드 현황(2026-07-21): /auth/pending·approve·reject = 관리자 역할 진입 후 서비스가 target role 범위 강제.
// schedule·reports 읽기 = 로그인(STAFF). money/payouts 전체 읽기 = super_admin 전용.
// instructor payout은 /payouts/me에서 지급 완료(paid) 내역만 — 시수 산정·readiness는 관리자 전용(TBO-62 ⑥).
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

  describe("관리자 역할 — /auth/pending", () => {
    it("super_admin → 200", async () => {
      await http.get("/api/auth/pending").set(auth("super_admin")).expect(200);
    });
    it("manager → 200 (응답 행은 서비스가 instructor 요청으로 제한)", async () => {
      await http.get("/api/auth/pending").set(auth("manager")).expect(200);
    });
    it("instructor → 403", async () => {
      await http.get("/api/auth/pending").set(auth("instructor")).expect(403);
    });
    it("토큰 없음 → 401", async () => {
      await http.get("/api/auth/pending").expect(401);
    });
  });

  describe("관리자 역할 — /auth/approve/:id", () => {
    it("manager는 route 진입 후 존재하지 않는 대상이면 404", async () => {
      await http.post("/api/auth/approve/999").set(auth("manager")).send({}).expect(404);
    });
    it("instructor → 403", async () => {
      await http.post("/api/auth/approve/999").set(auth("instructor")).send({}).expect(403);
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

  describe("강사 읽기 scope — 본인 데이터만", () => {
    it("instructor(park) → GET /schedule 은 본인 강사 세션만 반환", async () => {
      const rows = (await http.get("/api/schedule").set(auth("instructor")).expect(200)).body;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { instructorId: number }) => Number(r.instructorId) === 1)).toBe(true);
    });

    it("instructor(park) → GET /schedule?instructorId=2 도 본인 강사 세션으로 강제", async () => {
      const rows = (await http.get("/api/schedule?instructorId=2").set(auth("instructor")).expect(200)).body;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r: { instructorId: number }) => Number(r.instructorId) === 1)).toBe(true);
    });

    it("instructor(park) → GET /schedule/resources 는 본인 강사·코스·학생만 반환", async () => {
      const res = (await http.get("/api/schedule/resources").set(auth("instructor")).expect(200)).body;
      expect(res.instructors.map((i: { id: number }) => i.id)).toEqual([1]);
      expect(res.courses.length).toBeGreaterThan(0);
      expect(res.courses.every((c: { instructorId: number }) => Number(c.instructorId) === 1)).toBe(true);
      expect(res.students.map((s: { id: number }) => Number(s.id)).sort()).toEqual([1, 4]);
      const visibleStudentIds = new Set(res.students.map((student: { id: number }) => Number(student.id)));
      expect(res.courses.every((course: { subjectId: number; studentIds: number[] }) =>
        Number.isInteger(course.subjectId) && course.studentIds.every((studentId) => visibleStudentIds.has(Number(studentId))))).toBe(true);
    });

    it("instructor(park) → GET /availability 는 쿼리 우회에도 본인 강사 블록만 반환", async () => {
      const rows = (await http
        .get("/api/availability?ownerType=instructor&ownerId=2")
        .set(auth("instructor"))
        .expect(200)).body as { ownerType: string; ownerId: number }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.ownerType === "instructor" && Number(row.ownerId) === 1)).toBe(true);
    });

    it("instructor(park) → POST /availability/impact 타 owner 조회 403", async () => {
      await http
        .post("/api/availability/impact")
        .set(auth("instructor"))
        .send({ ownerType: "instructor", ownerId: 2, kind: "unavailable", weekday: 1, startTime: "10:00", endTime: "11:00" })
        .expect(403);
    });

    it("instructor(park) → GET /attendance 는 본인 세션 출결만, 타 강사 sessionId 직접 조회는 403", async () => {
      const rows = (await http.get("/api/attendance").set(auth("instructor")).expect(200)).body;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((a: { sessionId: number }) => Number(a.sessionId) === 21)).toBe(false);
      await http.get("/api/attendance?sessionId=21").set(auth("instructor")).expect(403);
    });
  });

  // [TBO-21 RBAC] 정산 전체는 대표 전용. 강사는 /me 계열에서 본인 정산/시수만 조회.
  describe("정산 읽기(GET /payouts) — 대표 전체·강사 본인 scope", () => {
    it("super_admin → GET /payouts 200", async () => {
      await http.get("/api/payouts").set(auth("super_admin")).expect(200);
    });
    it("manager → GET /payouts 403 (돈 관련 제외)", async () => {
      await http.get("/api/payouts").set(auth("manager")).expect(403);
    });
    it("instructor → GET /payouts 403 (수평 권한 차단)", async () => {
      await http.get("/api/payouts").set(auth("instructor")).expect(403);
    });
    it("instructor → GET /payouts/me 200 + 본인 지급 완료(paid)만 반환(TBO-62 ⑥)", async () => {
      const rows = (await http.get("/api/payouts/me").set(auth("instructor")).expect(200)).body;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.every((p: { instructorId: number; status: string }) => Number(p.instructorId) === 1 && p.status === "paid")).toBe(true);
    });
    it("instructor → GET /payouts/me/preview 라우트 제거(404) — 시수 산정은 관리자 전용(TBO-62 ⑥)", async () => {
      await http
        .get("/api/payouts/me/preview")
        .query({ from: "2026-07-01", to: "2026-07-31" })
        .set(auth("instructor"))
        .expect(404);
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

  describe("돈 관련 API — 대표 전용", () => {
    const moneyReads = ["/api/payments", "/api/expenses", "/api/transactions"];
    for (const path of moneyReads) {
      it(`super_admin → GET ${path} 200`, async () => {
        await http.get(path).set(auth("super_admin")).expect(200);
      });
      it(`manager → GET ${path} 403`, async () => {
        await http.get(path).set(auth("manager")).expect(403);
      });
      it(`instructor → GET ${path} 403`, async () => {
        await http.get(path).set(auth("instructor")).expect(403);
      });
      it(`토큰 없음 → GET ${path} 401`, async () => {
        await http.get(path).expect(401);
      });
    }
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
    it("instructor → POST /schedule/conflicts 타 학생·타 수업 제외는 403", async () => {
      const input = { sessionDate: "2026-07-06", startTime: "10:00", endTime: "11:00", instructorId: 2, roomId: 1 };
      await http.post("/api/schedule/conflicts").set(auth("instructor")).send({ ...input, studentIds: [2] }).expect(403);
      await http.post("/api/schedule/conflicts").set(auth("instructor")).send({ ...input, ignoreSessionId: 21 }).expect(403);
    });
    it("토큰 없음 → GET /users/exists 401", async () => {
      await http.get("/api/users/exists").query({ webId: "admin" }).expect(401);
    });
    it("manager → GET /users/exists 200", async () => {
      await http.get("/api/users/exists").query({ webId: "admin" }).set(auth("manager")).expect(200);
    });
  });

  // [TBO-82] 출결 쓰기는 대표 전용. 보고서 소유권은 담당 강사 규칙을 유지한다.
  //  시드: 세션 20=강사1(park_inst) · 세션 21=강사2(jung_inst). 보고서 id 2=세션21·강사2.
  describe("출결 대표 전용 + 보고서 소유권", () => {
    it("instructor(park) → PUT /attendance 타 강사 세션(21) 403", async () => {
      await http.put("/api/attendance").set(auth("instructor")).send({ sessionId: 21, studentId: 2, status: "present" }).expect(403);
    });
    it("instructor(park) → PUT /attendance 본인 세션(20)도 403", async () => {
      await http.put("/api/attendance").set(auth("instructor")).send({ sessionId: 20, studentId: 1, status: "present" }).expect(403);
    });
    it("manager → PUT /attendance 타 강사 세션(21) 403", async () => {
      await http.put("/api/attendance").set(auth("manager")).send({ sessionId: 21, studentId: 2, status: "present" }).expect(403);
    });
    it("super_admin → PUT /attendance 통과", async () => {
      await http.put("/api/attendance").set(auth("super_admin")).send({ sessionId: 21, studentId: 2, status: "present" }).expect(200);
    });
    it("manager/instructor → 강사 출결 전용 POST와 일반 schedule PATCH 우회 모두 403", async () => {
      await http.post("/api/schedule/20/instructor-attendance").set(auth("manager")).send({ status: "present" }).expect(403);
      await http.post("/api/schedule/20/instructor-attendance").set(auth("instructor")).send({ status: "present" }).expect(403);
      await http.patch("/api/schedule/20").set(auth("manager")).send({ instructorAttendance: "present" }).expect(403);
      await http.patch("/api/schedule/20").set(auth("manager")).send({ clearInstructorAttendance: true }).expect(403);
    });
    it("instructor(park) → POST /reports 타 강사 세션(21) 403", async () => {
      await http.post("/api/reports").set(auth("instructor")).send({ sessionId: 21, studentId: 2, instructorId: 2, content: "x" }).expect(403);
    });
    it("instructor(park) → POST /reports/2/submit 타 강사 보고서 403", async () => {
      await http.post("/api/reports/2/submit").set(auth("instructor")).send({}).expect(403);
    });
  });

  // 백오피스 쓰기 액션은 역할별로 분리: 보고서=manager 이상, 지출·페이=대표 전용.
  // 가드가 핸들러보다 먼저 실행되므로 id가 유효하지 않아도 인가 결과(403/401)가 먼저 나온다.
  describe("RolesGuard — 관리자/대표 전용 쓰기 액션 거부", () => {
    const adminWrites = ["/api/reports/999/approve"];
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

    const superOnlyWrites = ["/api/payouts/999/confirm", "/api/expenses/999/approve", "/api/payments/999/pay"];
    for (const path of superOnlyWrites) {
      it(`manager → POST ${path} 403 (대표 전용)`, async () => {
        await http.post(path).set(auth("manager")).send({}).expect(403);
      });
      it(`super_admin → POST ${path} 통과(가드 허용, 403/401 아님)`, async () => {
        const res = await http.post(path).set(sudoAuthHeaders(app, tokens.super_admin)).send({});
        expect([401, 403]).not.toContain(res.status);
      });
    }
  });
});
