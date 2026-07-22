import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export const OPENAPI_TITLE = 'TACO ERP API';
export const OPENAPI_VERSION = '1.0.0';
export const OPENAPI_DESCRIPTION =
  'TnAcademy 백오피스 운영 API. Postgres 영속 저장소와 역할 기반 접근 제어를 사용하는 실제 서비스 계약.';

/**
 * Deliberately public operations. This is the single source of truth shared by
 * generated OpenAPI security metadata and the unauthenticated E2E sweep.
 */
export const PUBLIC_OPENAPI_OPERATION_KEYS = new Set([
  'POST /api/auth/signup',
  'POST /api/auth/signup-email-challenge',
  'POST /api/auth/signup-email-challenge/{id}/confirm',
  'GET /api/auth/web-id-available',
  'GET /api/auth/verify-email',
  'POST /api/auth/login',
  'POST /api/auth/refresh',
  'POST /api/auth/logout',
  'POST /api/auth/recover-id',
  'POST /api/auth/recover-password',
  'POST /api/auth/reset-password',
  'POST /api/auth/recovery-email-challenge',
  'POST /api/auth/recovery-email-challenge/{id}/confirm',
  'POST /api/auth/recover-id/complete',
  'POST /api/auth/reset-password-otp',
  'GET /api/health',
  'GET /api/health/db',
]);

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

export function buildOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle(OPENAPI_TITLE)
    .setDescription(OPENAPI_DESCRIPTION)
    .setVersion(OPENAPI_VERSION)
    .addServer('/', '현재 호스트')
    .addBearerAuth()
    .addCookieAuth('access_token', undefined, 'access_token')
    .build();
}

export function applyOpenApiSecurity(document: OpenAPIObject): OpenAPIObject {
  // Protected by default. Public exceptions are explicitly marked per operation.
  document.security = [{ bearer: [] }, { access_token: [] }];
  const discoveredPublic = new Set<string>();

  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method) || !operation || typeof operation !== 'object') continue;
      const key = `${method.toUpperCase()} ${path}`;
      if (PUBLIC_OPENAPI_OPERATION_KEYS.has(key)) {
        (operation as { security?: Array<Record<string, string[]>> }).security = [];
        discoveredPublic.add(key);
      } else {
        (operation as { security?: Array<Record<string, string[]>> }).security = [{ bearer: [] }, { access_token: [] }];
      }
    }
  }

  const missing = [...PUBLIC_OPENAPI_OPERATION_KEYS].filter((key) => !discoveredPublic.has(key));
  if (missing.length) throw new Error(`OpenAPI public operation is missing from generated routes: ${missing.join(', ')}`);
  return document;
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  return applyOpenApiSecurity(SwaggerModule.createDocument(app, buildOpenApiConfig()));
}
