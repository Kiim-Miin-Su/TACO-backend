import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./setup-app";

// [B-1 R-3 2차 회귀 가드] schedule.service.mergeFields 병합·기본값 계약 잠금.
//  SESSION_DEFAULTS 단일 상수화 리팩토링 전에 현재 동작을 고정한다(값 동일 유지 검증용):
//   · 생성 기본값(kind=class·mode=in_person·status=scheduled·duration=60)
//   · 부분 PATCH 시 미지정 필드 보존(kind/mode/price/memo/color)
//   · 이동(startTime만)=시수 보존+endTime 재파생 / 리사이즈(duration만)=startTime 보존+endTime 갱신
//   · 코스 변경 시 강사·topic이 새 코스 기본값 승계
//  hermetic: 시드·주간 조회와 무관한 미래 날짜(2099) 사용.
describe("Schedule mergeFields 병합/기본값 (e2e) [B-1]", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let TOKEN = "";
  const TH = () => ({ Authorization: `Bearer ${TOKEN}` });

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    TOKEN = (await http.post("/api/auth/login").send({ webId: "admin", password: "demo1234" }).expect(201)).body.accessToken;
  });
  afterAll(async () => { await app.close(); });

  // 공통 생성 헬퍼(미래 날짜·force) → row 반환
  const make = async (body: Record<string, unknown>) =>
    (await http.post("/api/schedule").set(TH()).send({ force: true, ...body }).expect(201)).body.row;

  it("생성 기본값: 미지정 시 kind=class · mode=in_person · status=scheduled · duration=60", async () => {
    const row = await make({ courseId: 10, sessionDate: "2099-07-06", startTime: "10:00" });
    expect(row.kind).toBe("class");
    expect(row.mode).toBe("in_person");
    expect(row.status).toBe("scheduled");
    expect(row.durationMinutes).toBe(60);
    expect(row.endTime).toBe("11:00"); // start+60 파생
  });

  it("부분 PATCH: topic만 바꿔도 kind/mode/price/memo/color 보존", async () => {
    const row = await make({
      courseId: 10, sessionDate: "2099-07-07", startTime: "10:00", durationMinutes: 90,
      kind: "counsel", mode: "online", price: 50000, memo: "준비물 A", color: "#bf3989",
    });
    const patched = (await http.patch(`/api/schedule/${row.id}`).set(TH()).send({ topic: "주제 변경", force: true }).expect(200)).body.row;
    expect(patched.topic).toBe("주제 변경");
    expect(patched.kind).toBe("counsel");
    expect(patched.mode).toBe("online");
    expect(patched.price).toBe(50000);
    expect(patched.memo).toBe("준비물 A");
    expect(patched.color).toBe("#bf3989");
  });

  it("이동(startTime만): durationMinutes 보존 + endTime 재파생", async () => {
    const row = await make({ courseId: 10, sessionDate: "2099-07-08", startTime: "10:00", durationMinutes: 90 });
    expect(row.endTime).toBe("11:30");
    const moved = (await http.patch(`/api/schedule/${row.id}`).set(TH()).send({ startTime: "14:00", force: true }).expect(200)).body.row;
    expect(moved.startTime).toBe("14:00");
    expect(moved.durationMinutes).toBe(90); // 시수 보존
    expect(moved.endTime).toBe("15:30"); // 14:00 + 90 재파생
  });

  it("리사이즈(durationMinutes만): startTime 보존 + endTime 갱신", async () => {
    const row = await make({ courseId: 10, sessionDate: "2099-07-08", startTime: "16:00", durationMinutes: 60 });
    const resized = (await http.patch(`/api/schedule/${row.id}`).set(TH()).send({ durationMinutes: 120, force: true }).expect(200)).body.row;
    expect(resized.startTime).toBe("16:00"); // 보존
    expect(resized.durationMinutes).toBe(120);
    expect(resized.endTime).toBe("18:00"); // 16:00 + 120
  });

  it("코스 변경(courseId): 강사·topic이 새 코스 기본값 승계", async () => {
    const row = await make({ courseId: 10, sessionDate: "2099-07-09", startTime: "10:00", durationMinutes: 60 });
    expect(row.instructorId).toBe(1); // 코스10 기본 강사
    const changed = (await http.patch(`/api/schedule/${row.id}`).set(TH()).send({ courseId: 11, force: true }).expect(200)).body.row;
    expect(changed.instructorId).toBe(2); // 코스11 기본 강사로 승계
    expect(changed.topic).toBe(changed.courseName); // topic = 새 코스명(topic 미지정 시)
  });

  it("상태 변경(status): 나머지 필드 보존", async () => {
    const row = await make({ courseId: 10, sessionDate: "2099-07-10", startTime: "10:00", durationMinutes: 60, mode: "online", kind: "level_test" });
    const held = (await http.patch(`/api/schedule/${row.id}`).set(TH()).send({ status: "held", force: true }).expect(200)).body.row;
    expect(held.status).toBe("held");
    expect(held.mode).toBe("online"); // 보존
    expect(held.kind).toBe("level_test"); // 보존
    expect(held.durationMinutes).toBe(60);
  });
});
