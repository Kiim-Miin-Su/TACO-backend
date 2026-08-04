import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './setup-app';
import { shouldExposeApiDocs } from '../src/config/swagger-exposure';

describe('HTTP security headers and Swagger exposure', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('adds the centralized API response guards without an API CSP', async () => {
    const response = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('keeps docs available outside production unless explicitly disabled', () => {
    expect(shouldExposeApiDocs({ NODE_ENV: 'test', EXPOSE_API_DOCS: undefined })).toBe(true);
    expect(shouldExposeApiDocs({ NODE_ENV: 'development', EXPOSE_API_DOCS: 'false' })).toBe(false);
  });

  it('keeps production docs closed unless explicitly enabled', () => {
    expect(shouldExposeApiDocs({ NODE_ENV: 'production', EXPOSE_API_DOCS: undefined })).toBe(false);
    expect(shouldExposeApiDocs({ NODE_ENV: 'production', EXPOSE_API_DOCS: 'false' })).toBe(false);
    expect(shouldExposeApiDocs({ NODE_ENV: 'production', EXPOSE_API_DOCS: 'true' })).toBe(true);
  });
});
