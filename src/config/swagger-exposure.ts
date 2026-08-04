import type { INestApplication } from '@nestjs/common';
import { SwaggerModule, type OpenAPIObject, type SwaggerCustomOptions } from '@nestjs/swagger';

type SwaggerEnvironment = { NODE_ENV?: string; EXPOSE_API_DOCS?: string };

export function shouldExposeApiDocs(env: SwaggerEnvironment = process.env): boolean {
  const explicit = env.EXPOSE_API_DOCS?.trim().toLowerCase();
  if (env.NODE_ENV === 'production') return explicit === 'true';
  return explicit !== 'false';
}

export function configureApiDocs(
  app: INestApplication,
  document: OpenAPIObject,
  options?: SwaggerCustomOptions,
): boolean {
  if (!shouldExposeApiDocs()) return false;
  SwaggerModule.setup('docs', app, document, options);
  return true;
}
