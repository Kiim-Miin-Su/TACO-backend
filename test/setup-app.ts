import "reflect-metadata";
import { appendFileSync } from "node:fs";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";

// main.ts와 동일한 부트 설정으로 e2e 앱 인스턴스 생성.
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api");
  // [B8 E4 2026-07-16] 라우트 커버리지 계측 — E2E_ROUTE_LOG=<file>일 때만, 응답마다
  //  "METHOD express-route-pattern status"를 append(테스트 하네스 전용 — 프로덕션 코드 무변경).
  //  scripts/e2e-route-coverage.ts가 openapi.json과 대조해 "미커버 라우트 0"을 기계 게이트로 만든다.
  const routeLog = process.env.E2E_ROUTE_LOG;
  if (routeLog) {
    app.use(
      (
        req: { method: string; route?: { path?: string } },
        res: { on: (event: string, cb: () => void) => void; statusCode: number },
        next: () => void,
      ) => {
        res.on("finish", () => {
          const pattern = req.route?.path; // 라우터 매칭 후에만 존재(스펙 밖 404는 제외)
          if (pattern) appendFileSync(routeLog, `${req.method} ${pattern} ${res.statusCode}\n`);
        });
        next();
      },
    );
  }
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }) /* 미허용 필드 400(mass-assignment 방어) */);
  await app.init();
  return app;
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
