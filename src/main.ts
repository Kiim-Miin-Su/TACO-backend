import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 프론트(Next.js)와 분리 운영 — CORS 허용
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

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
