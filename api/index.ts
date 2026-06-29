import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';

// ─────────────────────────────────────────────────────────────
// Vercel 서버리스 엔트리. main.ts와 동일 부트 설정을 함수로 래핑.
// 콜드스타트마다 Nest 앱을 1회 부트하고 그 이후 캐시(express 인스턴스)를 재사용.
// ⚠️ in-memory 저장소는 함수 인스턴스 수명 동안만 유지(콜드스타트 시 초기 시드로 리셋) → 데모용.
//    영속이 필요하면 DB(TypeORM) 이관 후 사용.
// ─────────────────────────────────────────────────────────────
let cachedServer: ((req: unknown, res: unknown) => void) | undefined;

async function bootstrapServer() {
  const app = await NestFactory.create(AppModule);

  // WEB_ORIGIN(프론트 Vercel 도메인) 미지정 시 모든 오리진 허용(데모). 운영은 도메인 지정 권장.
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? true, credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const config = new DocumentBuilder()
    .setTitle('TACO ERP API')
    .setDescription('TnAcademy 백오피스 API (in-memory, serverless). 설계 스펙: docs/api/openapi.yaml')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  await app.init();
  return app.getHttpAdapter().getInstance() as (req: unknown, res: unknown) => void;
}

// Vercel Node 함수 시그니처(req, res는 Node IncomingMessage/ServerResponse 호환).
export default async function handler(req: unknown, res: unknown): Promise<void> {
  if (!cachedServer) cachedServer = await bootstrapServer();
  cachedServer(req, res);
}
