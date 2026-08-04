import 'reflect-metadata';
import { loadLocalEnv } from './config/load-env';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertProductionBootSafety } from './config/production-guards';
import { createOpenApiDocument } from './config/openapi';
import { RidConsoleLogger } from './common/request-context'; // [TBO-58 P2]
import { configureApp } from './config/configure-app';
import { configureApiDocs } from './config/swagger-exposure';
import {
  markRuntimeReady,
  measurePerformance,
  measurePerformanceSync,
} from './common/performance-timing';

// [env 2026-07-03] .env 로드 — 네이티브(Node 20.12+/22, 의존성 없음). AuthService 등이 process.env를
//  읽기 전(=NestFactory.create 인스턴스화 전)에 채워야 하므로 여기서 먼저 로드한다.
//  .env → .env.local 순(뒤가 우선). 파일 없으면(운영/Vercel — env는 플랫폼이 주입) 조용히 무시.
for (const f of ['.env', '.env.local']) {
  try { (process as NodeJS.Process & { loadEnvFile: (p: string) => void }).loadEnvFile(f); } catch { /* 파일 없음 — 무시 */ }
}

async function bootstrap() {
  measurePerformanceSync('boot.loadEnv', () => loadLocalEnv());
  measurePerformanceSync('boot.productionGuard', () => assertProductionBootSafety()); // [TBO-28B] production 필수 env fail-fast(§4 — DB·JWT·SMTP)
  // [TBO-58 P2] RidConsoleLogger — 전 Logger 출력(HTTP·ERROR·money 등 도메인 스코프)에 rid 자동 첨부
  const app = await measurePerformance('boot.nestCreate', () =>
    NestFactory.create(AppModule, { logger: new RidConsoleLogger() }));
  measurePerformanceSync('boot.configureApp', () => configureApp(app));

  // Swagger — http://localhost:3001/docs (JSON: /docs-json)
  const document = measurePerformanceSync('boot.openapiDocument', () => createOpenApiDocument(app));
  const docsEnabled = measurePerformanceSync('boot.configureDocs', () => configureApiDocs(app, document));

  const port = Number(process.env.PORT ?? 3001);
  await measurePerformance('boot.appInit', () => app.init());
  await measurePerformance('boot.listen', () => app.listen(port));
  measurePerformanceSync('boot.ready', () => markRuntimeReady());
  console.log(`TACO API ready on http://localhost:${port}/api${docsEnabled ? ' · docs: /docs' : ''}`);
}
bootstrap();
