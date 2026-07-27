import { directDatabaseUrl, runtimeDatabaseUrl } from '../src/database/database-url';

describe('database URL role boundary', () => {
  const keys = [
    'RUNTIME_DATABASE_URL',
    'DATABASE_URL',
    'DATABASE_URL_UNPOOLED',
    'POSTGRES_URL',
    'POSTGRES_URL_NON_POOLING',
    'POSTGRES_PRISMA_URL',
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });

  afterAll(() => {
    for (const key of keys) {
      const value = before[key];
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('runtime은 integration owner URL보다 DML 전용 URL을 우선한다', () => {
    process.env.RUNTIME_DATABASE_URL = 'postgresql://runtime@example/runtime';
    process.env.DATABASE_URL = 'postgresql://owner@example/owner';

    expect(runtimeDatabaseUrl()).toBe('postgresql://runtime@example/runtime');
  });

  it('migration direct URL은 runtime URL과 분리된다', () => {
    process.env.RUNTIME_DATABASE_URL = 'postgresql://runtime@example/runtime';
    process.env.DATABASE_URL_UNPOOLED = 'postgresql://owner@example/owner';

    expect(runtimeDatabaseUrl()).toBe('postgresql://runtime@example/runtime');
    expect(directDatabaseUrl()).toBe('postgresql://owner@example/owner');
  });
});
