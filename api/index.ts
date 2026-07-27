import "reflect-metadata";
import type { ServerResponse } from "node:http";
import { NestFactory } from "@nestjs/core";
import { SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { AppModule } from "../src/app.module";
import { assertProductionBootSafety } from "../src/config/production-guards";
import { createOpenApiDocument } from "../src/config/openapi";
import { configureApp } from "../src/config/configure-app";
import { RidConsoleLogger } from "../src/common/request-context";
import staticOpenapiJson from "../openapi.json";

// Production cold starts initialize and hydrate the Postgres-backed runtime stores before
// the first request can be served. Vercel's default function duration can expire during that
// work, so keep the entrypoint within an explicit, documented upper bound.
export const config = { maxDuration: 60 };

// 서버리스(@vercel/node)는 런타임 컴파일에서 데코레이터 메타데이터/Swagger 플러그인이
// 소실돼 request body·parameter 스키마가 비어 보일 수 있다. → 빌드 타임에 생성해 커밋한
// openapi.json(npm run openapi)을 우선 서빙한다. 없으면 런타임 생성으로 폴백.
const staticOpenapi = staticOpenapiJson as unknown as OpenAPIObject;

// ─────────────────────────────────────────────────────────────
// Vercel 서버리스 엔트리. main.ts와 동일 부트 설정을 함수로 래핑.
// 콜드스타트마다 Nest 앱을 1회 부트하고 그 이후 캐시(express 인스턴스)를 재사용.
// Postgres가 구성된 production에서는 영속 store가 권위이며, 메모리는 인스턴스별 read model로만 사용한다.
// ─────────────────────────────────────────────────────────────
let cachedServer: ((req: unknown, res: unknown) => void) | undefined;
let bootstrapPromise: Promise<((req: unknown, res: unknown) => void)> | undefined;

async function bootstrapServer() {
  console.log("[boot] serverless bootstrap start");
  assertProductionBootSafety(); // [TBO-28B] production 필수 env fail-fast(§4 — DB·JWT·SMTP)
  console.log("[boot] production guard passed");
  const app = await NestFactory.create(AppModule, {
    logger: new RidConsoleLogger(),
  });
  console.log("[boot] Nest application created");
  configureApp(app);

  // 빌드 타임 스펙 우선(파라미터·스키마 정확). 없으면 런타임 생성으로 폴백.
  const document = staticOpenapi ?? createOpenApiDocument(app);
  // 서버리스(Vercel)는 Swagger UI 정적 에셋을 서빙하지 못해 흰 화면이 됨.
  // → JS/CSS를 CDN(jsdelivr swagger-ui-dist)에서 로드하도록 지정.
  SwaggerModule.setup("docs", app, document, {
    customCssUrl: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css",
    customJs: [
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js",
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js",
    ],
  });

  console.log("[boot] Nest application init start");
  await app.init();
  console.log("[boot] serverless bootstrap ready");
  return app.getHttpAdapter().getInstance() as (req: unknown, res: unknown) => void;
}

function getServer(): Promise<((req: unknown, res: unknown) => void)> {
  if (cachedServer) return Promise.resolve(cachedServer);
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrapServer()
      .then((server) => {
        cachedServer = server;
        return server;
      })
      .catch((error: unknown) => {
        bootstrapPromise = undefined;
        const details = error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: String(error) };
        console.error("[boot] serverless bootstrap failed", details);
        throw error;
      });
  }
  return bootstrapPromise;
}

// Vercel Node 함수 시그니처(req, res는 Node IncomingMessage/ServerResponse 호환).
export default async function handler(req: unknown, res: unknown): Promise<void> {
  try {
    const server = await getServer();
    server(req, res);
  } catch {
    const response = res as ServerResponse;
    if (response.headersSent) return;
    response.statusCode = 503;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({
      status: "unavailable",
      service: "taco-api",
      code: "BOOT_FAILED",
    }));
  }
}
