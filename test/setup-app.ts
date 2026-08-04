import "reflect-metadata";
import { appendFileSync } from "node:fs";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/config/configure-app";
import { AuthService } from "../src/modules/auth/auth.service";
import { SUDO_COOKIE } from "../src/modules/auth/browser-session";
import { seedBusinessFixtures } from "./fixtures/seed-business-fixtures";

// Full e2e runs compile and dispose more than a hundred Nest applications in one process.
// Keep request/test stalls on the global 20s budget while allowing a later suite's one-time
// module compilation to survive GC and CI CPU contention without relying on Jest retry.
export const E2E_APP_BOOT_TIMEOUT_MS = 60_000;

// main.ts와 동일한 부트 설정으로 e2e 앱 인스턴스 생성.
export async function createTestApp(): Promise<INestApplication> {
  const shouldSeedFixtures = process.env.TEST_BUSINESS_FIXTURES !== '0';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, { cors: false, observability: false });
  // [B8 E4 2026-07-16] 라우트 커버리지 계측 — E2E_ROUTE_LOG=<file>일 때만, 응답마다
  //  "METHOD express-route-pattern status"를 append(테스트 하네스 전용 — 프로덕션 코드 무변경).
  //  scripts/e2e-route-coverage.ts가 openapi.json과 대조해 "미커버 라우트 0"을 기계 게이트로 만든다.
  //
  // [TBO-79 K3] **계측은 측정 대상을 바꿀 수 없어야 한다.** 종전 코드는 `res.on('finish')` 안에서
  //  `appendFileSync`를 맨몸으로 호출했다. 여기서 던지는 예외(EMFILE·ENOENT·권한 등)는 이벤트
  //  핸들러의 **처리되지 않은 예외**가 되어 테스트 프로세스를 오염시킨다 — 즉 계측이 실패를
  //  만들어낼 수 있었다. 이 경로는 TBO-79 K1에서 release 게이트에 편입되면서 처음으로 상시
  //  실행되기 시작했으므로, 그 위험을 여기서 닫는다.
  //  실패는 한 번만 알리고 계측을 스스로 끈다(로그가 불완전해지면 커버리지 게이트가 미커버로
  //  판정해 조용히 넘어가지 않는다 — 조용한 실패보다 시끄러운 실패가 낫다).
  const routeLog = process.env.E2E_ROUTE_LOG;
  if (routeLog) {
    let instrumentationBroken = false;
    app.use(
      (
        req: { method: string; route?: { path?: string } },
        res: { on: (event: string, cb: () => void) => void; statusCode: number },
        next: () => void,
      ) => {
        res.on("finish", () => {
          if (instrumentationBroken) return;
          try {
            const pattern = req.route?.path; // 라우터 매칭 후에만 존재(스펙 밖 404는 제외)
            if (pattern) appendFileSync(routeLog, `${req.method} ${pattern} ${res.statusCode}\n`);
          } catch (error) {
            instrumentationBroken = true;
            // eslint-disable-next-line no-console
            console.error(
              `[route-coverage] 계측 기록 실패 — 이후 기록을 중단합니다(테스트 결과에는 영향 없음): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        });
        next();
      },
    );
  }
  // Supertest에 init-only server를 넘기면 요청마다 임시 listen/close가 반복된다. 전체 회귀는
  // 100개가 넘는 앱과 수천 요청을 순차 실행하므로 이 포트 churn이 간헐 404/401을 만들었다.
  // 스위트당 localhost ephemeral port를 한 번만 열어 운영과 같은 HTTP lifecycle을 사용한다.
  await app.listen(0, '127.0.0.1');
  if (shouldSeedFixtures) seedBusinessFixtures(app);
  return app;
}

/** 도메인 무결성 테스트용 step-up header. SudoGuard 자체 흐름은 security-c2c가 HTTP reauth로 검증한다. */
export function sudoAuthHeaders(app: INestApplication, accessToken: string): { Authorization: string; Cookie: string } {
  const auth = app.get(AuthService);
  const actorId = auth.verify(accessToken).sub;
  return {
    Authorization: `Bearer ${accessToken}`,
    Cookie: `${SUDO_COOKIE}=${auth.signSudo(actorId)}`,
  };
}

// 결정론적: 현재 주의 월요일(UTC) — 백엔드 시드와 동일 규칙.
export function mondayISO(): string {
  const d = new Date();
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = u.getUTCDay();
  u.setUTCDate(u.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return u.toISOString().slice(0, 10);
}
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// [74D-0] 회계 영향 ack 신계약(hash 결속) 공용 헬퍼 — FE confirm 흐름과 동형:
//  1차는 ack 없이 시도 → 409 ACCOUNTING_IMPACT_ACK_REQUIRED면 서버가 준 impactHash로 1회 결속 재시도.
//  (맹목 acknowledgeAccountingImpact:true는 74D-0부터 서버가 거부한다 — stale 확인 차단)
export async function patchSessionAckingImpact(
  http: ReturnType<typeof import('supertest')>,
  headers: Record<string, string>,
  sessionId: number,
  body: Record<string, unknown>,
) {
  const first = await http.patch(`/api/schedule/${sessionId}`).set(headers).send(body);
  if (first.status !== 409 || first.body?.code !== 'ACCOUNTING_IMPACT_ACK_REQUIRED') return first;
  return http.patch(`/api/schedule/${sessionId}`).set(headers).send({
    ...body,
    acknowledgeAccountingImpact: true,
    expectedAccountingImpactHash: first.body.impactHash,
  });
}

/**
 * 종료된 회차를 운영 흐름대로 완료한다.
 * `held`는 명령 입력값이 아니라 학생 전원·강사 출결 사실에서 서버가 파생해야 한다.
 */
export async function completeSessionByAttendance(
  http: ReturnType<typeof import('supertest')>,
  headers: Record<string, string>,
  sessionId: number,
  studentIds: number[],
): Promise<void> {
  for (const studentId of studentIds) {
    await http.put('/api/attendance').set(headers).send({
      sessionId,
      studentId,
      status: 'present',
    }).expect(200);
  }
  const response = await patchSessionAckingImpact(http, headers, sessionId, {
    instructorAttendance: 'present',
    force: true,
  });
  if (response.status !== 200) {
    throw new Error(
      `Session ${sessionId} attendance completion failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  if (response.body?.row?.status !== 'held') {
    throw new Error(`Session ${sessionId} did not transition to held after complete attendance facts`);
  }
}
