import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, mondayISO, addDaysISO } from "./setup-app";

// 스케줄 API e2e — 참조 무결성(FK)·충돌(409/force)·시리즈 스코프·학생 코호트 필터 중심.
describe("Schedule API (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let ADMIN = '';
  const asAdmin = () => ({ Authorization: `Bearer ${ADMIN}` });
  const MON = mondayISO();
  const SUN = addDaysISO(MON, 6);

  // 스케줄 쓰기(create/update/delete)는 RolesGuard로 로그인 필수 → 데모 토큰 첨부.
  let TOKEN = "";
  const TH = () => ({ Authorization: `Bearer ${TOKEN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    ADMIN = (await http.post('/api/auth/login').send({ webId: 'admin', password: 'demo1234' }).expect(201)).body.accessToken;
    const login = await http.post("/api/auth/login").send({ webId: "admin", password: "demo1234" }).expect(201);
    TOKEN = login.body.accessToken;
  });
  afterAll(async () => {
    await app.close();
  });

  it("GET /schedule — enriched 행(요일·라벨·코호트 studentIds 포함)", async () => {
    const res = await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const r = res.body[0];
    expect(r).toHaveProperty("courseName");
    expect(r).toHaveProperty("instructorName");
    expect(Array.isArray(r.studentIds)).toBe(true);
    expect(Array.isArray(r.studentNames)).toBe(true);
  });

  // [v0.1.16 오류2] 수업방식(mode) — 시드 비대면 존재·생성 기본값·PATCH 변경·merge 유지·검증
  it("mode(수업방식): 시드 online 존재 + 생성 기본 in_person + PATCH 변경/유지 + 잘못된 값 400", async () => {
    const rows = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    expect(rows.some((r: { mode?: string }) => r.mode === "online")).toBe(true); // 시드: TOEFL 정규 = 비대면
    const created = (
      await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: addDaysISO(MON, 5), startTime: "07:00", durationMinutes: 60, force: true })
        .expect(201)
    ).body.row;
    expect(created.mode).toBe("in_person"); // 미지정=대면(하위호환)
    const patched = (await http.patch(`/api/schedule/${created.id}`).set(TH()).send({ mode: "online", force: true }).expect(200)).body.row;
    expect(patched.mode).toBe("online");
    const after = (await http.patch(`/api/schedule/${created.id}`).set(TH()).send({ topic: "mode 유지 확인", force: true }).expect(200)).body.row;
    expect(after.mode).toBe("online"); // merge가 mode 보존
    await http.patch(`/api/schedule/${created.id}`).set(TH()).send({ mode: "hybrid" }).expect(400); // IsIn 검증
    await http.delete(`/api/schedule/${created.id}`).set(TH()).expect(200); // 정리
  });

  it("GET /schedule/resources — 강사·강의실·학생·코스 옵션", async () => {
    const res = await http.get("/api/schedule/resources").set(asAdmin()).expect(200);
    expect(res.body.instructors.length).toBeGreaterThan(0);
    expect(res.body.rooms.length).toBeGreaterThan(0);
    expect(res.body.students.length).toBeGreaterThan(0);
    expect(res.body.courses.length).toBeGreaterThan(0);
    // 코스 옵션은 강사 FK와 정렬되어 있어야 함 + 진행시간(세션에서 파생) > 0
    for (const c of res.body.courses) {
      expect(res.body.instructors.some((i: { id: number }) => i.id === c.instructorId)).toBe(true);
      expect(c.durationMinutes).toBeGreaterThan(0);
    }
    // 코스11(AP Calculus)은 시드 세션이 120분 → 진행시간 120 파생
    const c11 = res.body.courses.find((c: { id: number }) => c.id === 11);
    expect(c11.durationMinutes).toBe(120);
  });

  it("시드 무결성: 불가시간/온라인만 가능 블록과 실제 수업이 겹치지 않는다", async () => {
    const rows = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    const blocks = (await http.get("/api/availability").set(asAdmin()).expect(200)).body;
    const toMin = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      return h * 60 + m;
    };
    const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
    const overlaps = rows.flatMap((r: { id: number; instructorId: number; roomId?: number; sessionDate: string; startTime?: string; endTime?: string; durationMinutes: number; mode?: string; courseName: string }) => {
      if (!r.startTime) return [];
      const s = toMin(r.startTime);
      const e = r.endTime ? toMin(r.endTime) : s + r.durationMinutes;
      return blocks
        .filter((b: { kind: string; weekday: number; ownerType: string; ownerId: number; startTime: string; endTime: string; effectiveFrom?: string; effectiveTo?: string }) =>
          (b.kind === "unavailable" || (b.kind === "online_only" && (r.mode ?? "in_person") !== "online")) &&
          b.weekday === weekdayOf(r.sessionDate) &&
          (!b.effectiveFrom || r.sessionDate >= b.effectiveFrom) &&
          (!b.effectiveTo || r.sessionDate <= b.effectiveTo) &&
          ((b.ownerType === "instructor" && b.ownerId === r.instructorId) || (b.ownerType === "room" && b.ownerId === r.roomId)) &&
          s < toMin(b.endTime) && toMin(b.startTime) < e,
        )
        .map((b: { kind: string; startTime: string; endTime: string }) => `${r.id}:${r.courseName}:${r.startTime}-${r.endTime} overlaps ${b.kind}:${b.startTime}-${b.endTime}`);
    });
    expect(overlaps).toEqual([]);
  });

  it("GET /schedule?studentId=2 — 학생2 코호트(코스11) 세션만", async () => {
    const res = await http.get(`/api/schedule?from=${MON}&to=${SUN}&studentId=2`).set(asAdmin()).expect(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const r of res.body) {
      expect(r.courseId).toBe(11);
      expect(r.studentIds).toContain(2);
    }
  });

  it("POST /schedule — 빈 슬롯 생성 성공(FK·시각 파생)", async () => {
    const res = await http
      .post("/api/schedule")
      .set(TH())
      .send({ courseId: 10, sessionDate: addDaysISO(MON, 1), startTime: "10:00", durationMinutes: 60 })
      .expect(201);
    expect(res.body.row).toMatchObject({ courseId: 10, startTime: "10:00", endTime: "11:00" });
    expect(res.body.row.instructorName).toBeTruthy();
    expect(res.body.conflicts).toEqual([]);
  });

  it("POST /schedule — 존재하지 않는 courseId → 400(참조 무결성)", async () => {
    await http
      .post("/api/schedule")
      .set(TH())
      .send({ courseId: 999, sessionDate: addDaysISO(MON, 1), startTime: "09:00", durationMinutes: 60 })
      .expect(400);
  });

  it("POST /schedule — 존재하지 않는 roomId → 400(참조 무결성)", async () => {
    await http
      .post("/api/schedule")
      .set(TH())
      .send({ courseId: 10, roomId: 9999, sessionDate: addDaysISO(MON, 1), startTime: "09:00", durationMinutes: 60 })
      .expect(400);
  });

  it("POST /schedule — 강사 이중예약(시드 월 16:00) → 409 conflicts", async () => {
    const res = await http
      .post("/api/schedule")
      .set(TH())
      .send({ courseId: 10, sessionDate: MON, startTime: "16:00", durationMinutes: 90 })
      .expect(409);
    const conflicts = res.body.conflicts ?? res.body.message?.conflicts ?? [];
    expect(JSON.stringify(res.body)).toContain("double_book");
  });

  it("POST /schedule — force=true면 충돌이 있어도 생성", async () => {
    const res = await http
      .post("/api/schedule")
      .set(TH())
      .send({ courseId: 10, sessionDate: MON, startTime: "16:00", durationMinutes: 90, force: true })
      .expect(201);
    expect(res.body.row.id).toBeGreaterThan(0);
    expect(res.body.conflicts.length).toBeGreaterThan(0); // 충돌은 보고됨
  });

  it("POST /schedule — 강사 불가시간(시드 월 12:00-13:00) 침범 → 409 unavailable", async () => {
    const res = await http
      .post("/api/schedule")
      .set(TH())
      .send({ courseId: 10, sessionDate: MON, startTime: "12:30", durationMinutes: 30 })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain("unavailable");
  });

  it("PATCH /schedule/:id — 존재하지 않는 roomId → 400(참조 무결성)", async () => {
    const list = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    const id = list[0].id;
    await http.patch(`/api/schedule/${id}`).set(TH()).send({ roomId: 9999 }).expect(400);
  });

  // [R-9 2026-07-06] 자정 크로스 정식 지원 — 구 [R-1b F4] 400 거부를 대체.
  // 드래그 이동 패치({startTime, durationMinutes})가 자정을 넘으면 이제 200: endTime을 저장하지 않고
  // durationMinutes로 파생(단일 세션·sessionDate=시작일). '25:00' 같은 무효 HH:mm은 여전히 DB에 없음.
  it("PATCH /schedule/:id — durationMinutes 경로 자정 초과 → 200·endTime 미저장(duration 파생) [R-9]", async () => {
    const list = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    const orig = list[0];
    const res = await http.patch(`/api/schedule/${orig.id}`).set(TH())
      .send({ startTime: "23:30", durationMinutes: 90, force: true }).expect(200);
    expect(res.body.row.startTime).toBe("23:30");
    expect(res.body.row.durationMinutes).toBe(90); // 시수 보존(이중 계상 없음 — 1레코드)
    expect(res.body.row.endTime == null).toBe(true); // 크로스 = endTime 미제공(FE가 duration 파생)
    expect(res.body.row.sessionDate).toBe(orig.sessionDate); // sessionDate = 시작일 유지
    // 원복(이후 테스트의 시드 레이아웃 보존)
    await http.patch(`/api/schedule/${orig.id}`).set(TH())
      .send({ startTime: orig.startTime, endTime: orig.endTime, force: true }).expect(200);
  });

  // [R-9 2026-07-06] 자정 크로스 생성·이틀 충돌 검사·시수 정합 — 옵션 B(단일 세션 모델) 회귀
  describe("자정 크로스 수업 [R-9]", () => {
    const D1 = "2099-06-01", D2 = "2099-06-02"; // 시드·주간 조회와 무관한 미래 날짜(hermetic)
    let crossId = 0;
    it("POST endTime<startTime(23:00→01:00) = 익일 종료 → 201·duration 120·endTime 미저장", async () => {
      const res = await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: D1, startTime: "23:00", endTime: "01:00" }).expect(201);
      crossId = res.body.row.id;
      expect(res.body.row.durationMinutes).toBe(120);
      expect(res.body.row.endTime == null).toBe(true);
      expect(res.body.row.sessionDate).toBe(D1); // 1레코드·시작일 기준(분할 없음)
    });
    it("시수 정합: 시작일 조회에만 1회 포함(익일 조회 미포함 — 이중 카운트 없음)", async () => {
      const day1 = (await http.get(`/api/schedule?from=${D1}&to=${D1}`).set(asAdmin()).expect(200)).body;
      const day2 = (await http.get(`/api/schedule?from=${D2}&to=${D2}`).set(asAdmin()).expect(200)).body;
      expect(day1.filter((r: { id: number }) => r.id === crossId)).toHaveLength(1);
      expect(day2.some((r: { id: number }) => r.id === crossId)).toBe(false);
    });
    it("이틀 충돌 ①: 시작일 잔여(23:30~) 겹침 → 409 double_book", async () => {
      const res = await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: D1, startTime: "23:30", durationMinutes: 30 }).expect(409);
      expect(JSON.stringify(res.body)).toContain("double_book");
    });
    it("이틀 충돌 ②: 익일 스필(00:30~) 겹침 → 409 double_book(같은 강사)", async () => {
      const res = await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: D2, startTime: "00:30", durationMinutes: 60 }).expect(409);
      expect(JSON.stringify(res.body)).toContain("double_book");
    });
    it("익일 01:00 맞닿음은 비겹침 → 201", async () => {
      const res = await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: D2, startTime: "01:00", durationMinutes: 60 }).expect(201);
      await http.delete(`/api/schedule/${res.body.row.id}`).set(TH()).expect(200); // 정리
    });
    it("가드 유지: 시작=종료 400 · 크로스 상한 480분 초과(10:00→09:00=23h) 400 · '25:00' 형식 400", async () => {
      await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: "2099-06-10", startTime: "10:00", endTime: "10:00" }).expect(400);
      await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: "2099-06-10", startTime: "10:00", endTime: "09:00" }).expect(400);
      await http.post("/api/schedule").set(TH())
        .send({ courseId: 10, sessionDate: "2099-06-10", startTime: "23:00", endTime: "25:00" }).expect(400); // DTO HHMM
    });
    it("정리: 크로스 세션 삭제", async () => {
      await http.delete(`/api/schedule/${crossId}`).set(TH()).expect(200);
    });
  });

  it("PATCH /schedule/:id — 시리즈 전체(scope=all) 동반 이동(updated>1)", async () => {
    // 시드: 코스10 시리즈(월·수·금) — 한 세션을 빈 시각으로 옮기되 scope=all
    const list = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    const target = list.find((r: { courseId: number; seriesId?: number }) => r.courseId === 10 && r.seriesId != null);
    expect(target).toBeTruthy();
    const res = await http
      .patch(`/api/schedule/${target.id}`)
      .set(TH())
      .send({ startTime: "09:00", endTime: "10:00", scope: "all", force: true })
      .expect(200);
    expect(res.body.updated).toBeGreaterThan(1);
  });

  it("memo 왕복: POST로 생성 시 저장 + PATCH로 수정", async () => {
    const created = (
      await http
        .post("/api/schedule")
        .set(TH())
        .send({
          courseId: 10,
          sessionDate: addDaysISO(MON, 1),
          startTime: "11:00",
          durationMinutes: 60,
          memo: "준비물: 교재 3장",
        })
        .expect(201)
    ).body.row;
    expect(created.memo).toBe("준비물: 교재 3장");

    const updated = (await http.patch(`/api/schedule/${created.id}`).set(TH()).send({ memo: "변경: 워크북 지참" }).expect(200))
      .body.row;
    expect(updated.memo).toBe("변경: 워크북 지참");
  });

  it("color 왕복: POST 색 저장 + PATCH 색 변경 / 미지정 시 코스 색 폴백", async () => {
    const created = (
      await http
        .post("/api/schedule")
        .set(TH())
        .send({ courseId: 10, sessionDate: addDaysISO(MON, 2), startTime: "13:00", durationMinutes: 60, color: "#bf3989" })
        .expect(201)
    ).body.row;
    expect(created.color).toBe("#bf3989");

    const updated = (await http.patch(`/api/schedule/${created.id}`).set(TH()).send({ color: "#9a6700" }).expect(200)).body.row;
    expect(updated.color).toBe("#9a6700");

    // color 미지정 → 코스10 색(#0969da) 폴백
    const fallback = (
      await http
        .post("/api/schedule")
        .set(TH())
        .send({ courseId: 10, sessionDate: addDaysISO(MON, 2), startTime: "15:00", durationMinutes: 60 })
        .expect(201)
    ).body.row;
    expect(fallback.color).toBe("#0969da");
  });

  it("DELETE /schedule/:id — 삭제 후 목록에서 사라짐", async () => {
    const created = (
      await http
        .post("/api/schedule")
        .set(TH())
        .send({ courseId: 10, sessionDate: addDaysISO(MON, 3), startTime: "14:00", durationMinutes: 60 })
        .expect(201)
    ).body.row;
    const del = (await http.delete(`/api/schedule/${created.id}`).set(TH()).expect(200)).body;
    expect(del).toMatchObject({ id: created.id, deleted: true });

    const list = (await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200)).body;
    expect(list.some((r: { id: number }) => r.id === created.id)).toBe(false);
  });

  it("DELETE /schedule/:id — 존재하지 않으면 404", async () => {
    await http.delete("/api/schedule/999999").set(TH()).expect(404);
  });

  it("충돌 시각(시드 월 16:00)을 취소로 변경 시 force 없이도 허용(충돌 무관)", async () => {
    // 시드 강사1 월 16:00 세션과 겹치도록 force 생성
    const occupy = (
      await http
        .post("/api/schedule")
        .set(TH())
        .send({ courseId: 10, sessionDate: MON, startTime: "16:00", durationMinutes: 90, force: true })
        .expect(201)
    ).body.row;
    // 이 세션을 '취소(no_show)'로 변경 — 겹침이 있어도 409 없이 200
    const res = (await http.patch(`/api/schedule/${occupy.id}`).set(TH()).send({ status: "no_show" }).expect(200)).body;
    expect(res.row.status).toBe("no_show");
  });

  it("결강(canceled) 세션은 시간 점유에서 제외 → 같은 슬롯 생성 가능", async () => {
    const day = addDaysISO(MON, 4);
    // 1) 슬롯 점유 세션 생성
    const occupy = (
      await http
        .post("/api/schedule")
        .set(TH())
        .send({ courseId: 10, sessionDate: day, startTime: "10:00", durationMinutes: 60 })
        .expect(201)
    ).body.row;
    // 2) 같은 슬롯 재생성 → 강사 이중예약 409
    await http
      .post("/api/schedule")
      .set(TH())
      .send({ courseId: 10, sessionDate: day, startTime: "10:00", durationMinutes: 60 })
      .expect(409);
    // 3) 점유 세션을 결강 처리 → 시간 점유 해제
    await http.patch(`/api/schedule/${occupy.id}`).set(TH()).send({ status: "canceled" }).expect(200);
    // 4) 이제 같은 슬롯 생성 성공(충돌 없음)
    const ok = (
      await http
        .post("/api/schedule")
        .set(TH())
        .send({ courseId: 10, sessionDate: day, startTime: "10:00", durationMinutes: 60 })
        .expect(201)
    ).body;
    expect(ok.conflicts).toEqual([]);
  });

  // ── RolesGuard(TBO-07): 쓰기는 로그인 필수, 읽기는 개방 ──
  it("인가: 비로그인 세션 생성 → 401", async () => {
    await http
      .post("/api/schedule")
      .send({ courseId: 10, sessionDate: addDaysISO(MON, 4), startTime: "10:00", durationMinutes: 60 })
      .expect(401);
  });

  it("인가: 강사 토큰 세션 생성 → 403 (TBO-16 #8 — 배정은 manager 이상, 강사는 schedule-requests로)", async () => {
    const login = await http.post("/api/auth/login").send({ webId: "park_inst", password: "demo1234" }).expect(201);
    const H = { Authorization: `Bearer ${login.body.accessToken}` };
    await http
      .post("/api/schedule")
      .set(H)
      .send({ courseId: 10, sessionDate: addDaysISO(MON, 4), startTime: "08:00", durationMinutes: 60, force: true })
      .expect(403);
    // 같은 입력이 요청 경로로는 접수된다(pending) — 정책 전환의 짝 검증
    const req = await http
      .post("/api/schedule-requests")
      .set(H)
      .send({ courseId: 10, sessionDate: addDaysISO(MON, 4), startTime: "08:00", durationMinutes: 60 })
      .expect(201);
    expect(req.body.row.status).toBe("pending");
  });

  it("인가: 읽기(GET)는 비로그인도 개방 → 200", async () => {
    await http.get(`/api/schedule?from=${MON}&to=${SUN}`).set(asAdmin()).expect(200);
  });
});
