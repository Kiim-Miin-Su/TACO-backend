import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./setup-app";
import { studentAggregateBody } from "./fixtures/student-profile";

describe("[TBO-76H] production organic journey", () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  const tokens: Record<string, string> = {};
  const auth = (role: string) => ({
    Authorization: `Bearer ${tokens[role]}`,
  });

  const pastDate = "2020-02-17";
  const futureDate = "2096-02-17";

  beforeAll(async () => {
    app = await createTestApp();
    http = request(app.getHttpServer());
    for (const [role, webId] of Object.entries({
      super_admin: "admin",
      manager: "manager",
      instructor: "park_inst",
    })) {
      tokens[role] = (
        await http
          .post("/api/auth/login")
          .send({ webId, password: "demo1234" })
          .expect(201)
      ).body.accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  // This journey is stateful by design. A retry could hide a partial commit.
  jest.retryTimes(0);

  it("학생+상담 등록부터 수업 held·리포트 승인·대표 시수 반영까지 한 흐름으로 완결한다", async () => {
    const intake = (
      await http
        .post("/api/students/registrations/with-counsel")
        .set(auth("manager"))
        .send({
          registration: {
            ...studentAggregateBody("76H 유기흐름 학생", {
              student: { status: "new_inquiry" },
              interests: [],
            }),
            guardians: [
              {
                name: "76H 보호자",
                phone: "010-7444-8899",
                relation: "모",
                isPrimary: true,
                isPayer: true,
              },
            ],
          },
          counsel: {
            referenceNotes: "76H 유기 흐름 상담",
            nextContactAt: "2096-02-10T10:30:00+09:00",
          },
        })
        .expect(201)
    ).body;
    const studentId = Number(intake.registration.student.id);
    const counselId = Number(intake.counsel.id);
    expect(studentId).toBeGreaterThan(0);
    expect(counselId).toBeGreaterThan(0);

    const [studentAggregate, counselAggregate] = await Promise.all([
      http
        .get(`/api/students/${studentId}/aggregate`)
        .set(auth("manager"))
        .expect(200),
      http
        .get(`/api/counsel/${counselId}/aggregate`)
        .set(auth("manager"))
        .expect(200),
    ]);
    expect(studentAggregate.body.student.id).toBe(studentId);
    expect(counselAggregate.body.student.student.id).toBe(studentId);

    await http
      .post("/api/schedule")
      .set(auth("instructor"))
      .send({
        courseId: 10,
        instructorId: 1,
        studentIds: [studentId],
        sessionDate: futureDate,
        startTime: "06:00",
        durationMinutes: 60,
        force: true,
      })
      .expect(403);

    const opened = (
      await http
        .post("/api/schedule/open-class")
        .set(auth("manager"))
        .send({
          subjectName: "76H Organic Writing",
          instructorId: 1,
          studentIds: [studentId],
          hourlyRateOverride: 60000,
          sessionDate: futureDate,
          startTime: "06:00",
          durationMinutes: 60,
          mode: "online",
          topic: "Production organic flow",
        })
        .expect(201)
    ).body;
    const sessionId = Number(opened.row.id);
    const courseId = Number(opened.course.id);
    expect(opened.enrollments).toEqual([
      expect.objectContaining({
        studentId,
        courseId,
        status: "active",
      }),
    ]);

    const report = (
      await http
        .post("/api/reports")
        .set(auth("instructor"))
        .send({
          sessionId,
          studentId,
          content: "문장 구조와 전치사 사용을 점검했습니다.",
          progressPage: "Vocab #6 PDF 문장 만들기",
          homework: "Vocab #6 문장 완성과 단어 암기",
          status: "draft",
        })
        .expect(201)
    ).body;
    await http
      .patch(`/api/reports/${report.id}`)
      .set(auth("instructor"))
      .send({ content: "문장 구조와 전치사 사용을 점검하고 첨삭했습니다." })
      .expect(200);

    const before = (
      await http
        .get("/api/payouts/preview")
        .set(auth("super_admin"))
        .query({ instructorId: 1, from: pastDate, to: pastDate })
        .expect(200)
    ).body;

    const moved = (
      await http
        .patch(`/api/schedule/${sessionId}`)
        .set(auth("manager"))
        .send({
          sessionDate: pastDate,
          startTime: "06:00",
          durationMinutes: 60,
          force: true,
        })
        .expect(200)
    ).body.row;
    expect(moved).toMatchObject({
      id: sessionId,
      status: "scheduled",
      instructorAttendance: null,
      attendanceRequired: true,
      missingAttendance: {
        instructor: true,
        studentIds: [studentId],
      },
    });

    const instructorRead = (
      await http
        .get(`/api/schedule/${sessionId}`)
        .set(auth("instructor"))
        .expect(200)
    ).body;
    expect(instructorRead.attendanceRequired).toBe(true);

    await http
      .put(`/api/schedule/${sessionId}/instructor-attendance`)
      .set(auth("instructor"))
      .send({ status: "present" })
      .expect(403);
    await http
      .put(`/api/schedule/${sessionId}/instructor-attendance`)
      .set(auth("super_admin"))
      .send({ status: "present" })
      .expect(200);
    await http
      .put(`/api/schedule/${sessionId}/instructor-attendance`)
      .set(auth("instructor"))
      .send({ status: "late" })
      .expect(403);
    await http
      .put("/api/attendance")
      .set(auth("super_admin"))
      .send({ sessionId, studentId, status: "present" })
      .expect(200);

    const held = (
      await http
        .get(`/api/schedule/${sessionId}`)
        .set(auth("manager"))
        .expect(200)
    ).body;
    expect(held).toMatchObject({
      status: "held",
      instructorAttendance: "present",
      attendanceRequired: false,
      missingAttendance: {
        instructor: false,
        studentIds: [],
      },
    });

    await http
      .post(`/api/reports/${report.id}/submit`)
      .set(auth("instructor"))
      .expect(201);
    const approved = (
      await http
        .post(`/api/reports/${report.id}/approve`)
        .set(auth("manager"))
        .expect(201)
    ).body;
    expect(approved.approvalStatus).toBe("approved");

    const after = (
      await http
        .get("/api/payouts/preview")
        .set(auth("super_admin"))
        .query({ instructorId: 1, from: pastDate, to: pastDate })
        .expect(200)
    ).body;
    expect(after.totalMinutes).toBe(before.totalMinutes + 60);
    expect(after.sessionCount).toBe(before.sessionCount + 1);
    expect(after.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          durationMinutes: 60,
        }),
      ]),
    );
  });
});
