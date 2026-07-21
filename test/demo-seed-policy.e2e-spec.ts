import type { INestApplication } from '@nestjs/common';
import { InMemoryDatabase } from '../src/database/in-memory.database';
import { createTestApp } from './setup-app';

describe('production data source boundary', () => {
  let app: INestApplication;
  const previousSeedDemo = process.env.SEED_DEMO;

  beforeAll(async () => {
    process.env.SEED_DEMO = '0';
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    if (previousSeedDemo === undefined) delete process.env.SEED_DEMO;
    else process.env.SEED_DEMO = previousSeedDemo;
  });

  it('does not create demo users or business rows when demo seeding is disabled', () => {
    const db = app.get(InMemoryDatabase);
    for (const table of ['users', 'students', 'courses', 'class_sessions', 'availability_blocks']) {
      expect(db.findAll(table)).toHaveLength(0);
    }
    expect(db.findAll('countries').length).toBeGreaterThan(0); // production reference catalog is not mock data
  });
});
