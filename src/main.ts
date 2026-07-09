import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { webCorsOrigins } from './common/cors-origin';
import { LoggingInterceptor } from './common/logging.interceptor';

// [env 2026-07-03] .env 로드 — 네이티브(Node 20.12+/22, 의존성 없음). AuthService 등이 process.env를
//  읽기 전(=NestFactory.create 인스턴스화 전)에 채워야 하므로 여기서 먼저 로드한다.
//  .env → .env.local 순(뒤가 우선). 파일 없으면(운영/Vercel — env는 플랫폼이 주입) 조용히 무시.
for (const f of ['.env', '.env.local']) {
  try { (process as NodeJS.Process & { loadEnvFile: (p: string) => void }).loadEnvFile(f); } catch { /* 파일 없음 — 무시 */ }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 프론트(Next.js)와 분리 운영 — CORS 허용.
  // 로컬은 QA 포트가 바뀔 수 있어 전체 origin 허용(origin=true), production은 WEB_ORIGIN/Vercel allowlist.
  app.enableCors({
    origin: webCorsOrigins(),
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }) /* 미허용 필드 400(mass-assignment 방어) */,
  );
  app.useGlobalInterceptors(new LoggingInterceptor()); // 모든 요청 로깅 category=http(docs/logging.md)
  app.useGlobalFilters(new AllExceptionsFilter()); // [R3] 예외 응답 표준화 + category=error(스택 응답 미노출)

  // Swagger — http://localhost:3001/docs (JSON: /docs-json)
  const swaggerConfig = new DocumentBuilder()
    .setTitle('TACO ERP API')
    .setDescription('TnAcademy 백오피스 API (in-memory). 전체 설계 스펙(현재+예정)은 docs/api/openapi.yaml 참고.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`TACO API ready on http://localhost:${port}/api · docs: /docs`);
}
bootstrap();
