import type { INestApplication } from '@nestjs/common';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { createTestApp } from './setup-app';

describe('production data source boundary', () => {
  let app: INestApplication;
  const previousFixtureMode = process.env.TEST_BUSINESS_FIXTURES;

  beforeAll(async () => {
    process.env.TEST_BUSINESS_FIXTURES = '0';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    if (previousFixtureMode === undefined) delete process.env.TEST_BUSINESS_FIXTURES;
    else process.env.TEST_BUSINESS_FIXTURES = previousFixtureMode;
  });

  it('keeps a fresh database empty when E2E business fixtures are disabled', () => {
    const db = app.get(InMemoryDatabase);
    for (const table of ['users', 'students', 'courses', 'class_sessions', 'availability_blocks']) {
      expect(db.findAll(table)).toHaveLength(0);
    }
    expect(db.findAll('countries').length).toBeGreaterThan(0); // production reference catalog is not mock data
  });
});
