import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { AppModule } from "../src/app.module";
import { AllExceptionsFilter } from "../src/common/all-exceptions.filter";
import { webCorsOrigins } from "../src/common/cors-origin";
import { LoggingInterceptor } from "../src/common/logging.interceptor";
import { assertProductionBootSafety } from "../src/config/production-guards";
import { configureTrustProxy } from "../src/common/trust-proxy";

// 서버리스(@vercel/node)는 런타임 컴파일에서 데코레이터 메타데이터/Swagger 플러그인이
// 소실돼 request body·parameter 스키마가 비어 보일 수 있다. → 빌드 타임에 생성해 커밋한
// openapi.json(npm run openapi)을 우선 서빙한다. 없으면 런타임 생성으로 폴백.
let staticOpenapi: OpenAPIObject | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  staticOpenapi = require("../openapi.json") as OpenAPIObject;
} catch {
  staticOpenapi = undefined;
}

// ─────────────────────────────────────────────────────────────
// Vercel 서버리스 엔트리. main.ts와 동일 부트 설정을 함수로 래핑.
// 콜드스타트마다 Nest 앱을 1회 부트하고 그 이후 캐시(express 인스턴스)를 재사용.
// ⚠️ in-memory 저장소는 함수 인스턴스 수명 동안만 유지(콜드스타트 시 초기 시드로 리셋) → 데모용.
//    영속이 필요하면 DB(TypeORM) 이관 후 사용.
// ─────────────────────────────────────────────────────────────
let cachedServer: ((req: unknown, res: unknown) => void) | undefined;

async function bootstrapServer() {
  assertProductionBootSafety(); // [TBO-28B] production 필수 env fail-fast(§4 — DB·JWT·SMTP)
  const app = await NestFactory.create(AppModule);
  configureTrustProxy(app);

  // 로컬은 QA 포트가 바뀔 수 있어 전체 origin 허용(origin=true), production은 WEB_ORIGIN/Vercel allowlist.
  app.enableCors({
    origin: webCorsOrigins(),
    credentials: true,
  });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalInterceptors(new LoggingInterceptor()); // 모든 요청 로깅(docs/logging.md)
  app.useGlobalFilters(new AllExceptionsFilter()); // 예외 응답 표준화 + category=error

  const config = new DocumentBuilder()
    .setTitle("TACO ERP API")
    .setDescription("TnAcademy 백오피스 API (in-memory, serverless). 설계 스펙: docs/api/openapi.yaml")
    .setVersion("0.1.0")
    .addBearerAuth()
    .addCookieAuth("access_token")
    .build();
  // 빌드 타임 스펙 우선(파라미터·스키마 정확). 없으면 런타임 생성으로 폴백.
  const document = staticOpenapi ?? SwaggerModule.createDocument(app, config);
  // 서버리스(Vercel)는 Swagger UI 정적 에셋을 서빙하지 못해 흰 화면이 됨.
  // → JS/CSS를 CDN(jsdelivr swagger-ui-dist)에서 로드하도록 지정.
  SwaggerModule.setup("docs", app, document, {
    customCssUrl: "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css",
    customJs: [
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js",
      "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js",
    ],
  });

  await app.init();
  return app.getHttpAdapter().getInstance() as (req: unknown, res: unknown) => void;
}

// Vercel Node 함수 시그니처(req, res는 Node IncomingMessage/ServerResponse 호환).
export default async function handler(req: unknown, res: unknown): Promise<void> {
  if (!cachedServer) cachedServer = await bootstrapServer();
  cachedServer(req, res);
}
